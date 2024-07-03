import {BoardIds, BoardShim, complex, DataFilter, DetrendOperations, FilterTypes, WindowOperations} from 'brainflow';
import {WebSocket} from 'ws'
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

const wss = new WebSocket.Server({port: 8080});

function sleep(ms: number) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

export interface BandPowers {
    delta: number;
    theta: number;
    alpha: number;
    beta: number;
    gamma: number;
}

interface PerChannel {
    channelIdx: number,
    raw: number[]
    filtered: number[]
    fft: complex[]
    bandPowers: BandPowers
    overThresholdIndices: number[]
}

async function runExample(): Promise<void> {
    const argv = yargs(hideBin(process.argv))
        .option('boardId', {
            alias: 'b',
            describe: 'The Brainflow board ID to connect to',
            type: 'number',
            demandOption: true
        })
        .option('channels', {
            alias: 'c',
            describe: 'Specify channel names',
            type: 'array',
            demandOption: true
        })
        .option('saveToInflux', {
            alias: 's',
            describe: 'Save data to InfluxDB',
            type: 'boolean',
            default: false
        })
        .parse();


    const channelNames = (argv as any).channels as string[];

    BoardShim.setLogLevel(0);
    BoardShim.releaseAllSessions()
    const boardId = (argv as any).boardId as BoardIds;
    console.info("Connecting to board")
    const board = new BoardShim(boardId, {
        serialPort: "COM11"
    });
    const eegChannels = BoardShim.getEegChannels(boardId).slice(0, channelNames.length);
    const samplingRate = BoardShim.getSamplingRate(boardId);

    let sampleBuffer: number[][] = Array(eegChannels.length).fill(null).map(() => []);

    console.info("Connected to board")
    board.prepareSession();
    console.info("Starting stream")
    board.startStream();
    console.info("Stream started")

    let startOfEpoch = new Date().getTime();
    let samplesPerEpoch = samplingRate

    while (true) {
        await sleep(samplesPerEpoch);

        const allData = board.getBoardData();

        eegChannels.forEach((channel, index) => {
            sampleBuffer[index] = sampleBuffer[index].concat(allData[channel]);
        });

        // Collect until we have enough samples.
        const numSamples = sampleBuffer[eegChannels[0]].length
        if (numSamples >= samplesPerEpoch) {
            const eegData: PerChannel[] = eegChannels.map((channel, index) => {
                const raw = sampleBuffer[index].slice(0, samplesPerEpoch);
                // console.info(`Processing ${raw.length} samples from ${sampleBuffer[index].length}`)

                sampleBuffer[index] = sampleBuffer[index].slice(samplesPerEpoch);

                const filtered = [...raw]

                if (filtered.some(value => value === undefined)) {
                    console.warn('Filtered data contains undefined values');
                }

                DataFilter.detrend(filtered, DetrendOperations.LINEAR)
                DataFilter.performBandPass(filtered, samplingRate, 4.0, 45.0, 4, FilterTypes.BUTTERWORTH_ZERO_PHASE, 0)
                DataFilter.performBandStop(filtered, samplingRate, 45.0, 80.0, 4, FilterTypes.BUTTERWORTH_ZERO_PHASE, 0)

                let fft: complex[] = []

                try {
                    // FFT has to be performed against data that is a power of 2
                    let nextPowerOfTwo = Math.pow(2, Math.ceil(Math.log(filtered.length) / Math.log(2)));
                    let padded = [...filtered, ...new Array(nextPowerOfTwo - filtered.length).fill(0)];

                    fft = DataFilter.performFft(padded, WindowOperations.HAMMING);
                } catch (e) {
                    console.error(e);
                }

                const bandPowers = DataFilter.getAvgBandPowers([filtered], [0], samplingRate, true)[0];

                // Using this as a cheap way of excluding epochs with blinks.
                const overThresholdIndices = filtered.reduce((indices: number[], sample, sampleIndex) => {
                    if (sample > 30 || sample < -30) {
                        indices.push(sampleIndex);
                    }
                    return indices;
                }, []);

                return {
                    channelIdx: index,
                    channelName: channelNames[index],
                    raw: raw,
                    filtered: filtered,
                    fft: fft,
                    bandPowers: {
                        delta: bandPowers[0],
                        theta: bandPowers[1],
                        alpha: bandPowers[2],
                        beta: bandPowers[3],
                        gamma: bandPowers[4]
                    },
                    overThresholdIndices: overThresholdIndices
                }
            });

            startOfEpoch = new Date().getTime();

            // Send to all websocket clients
            wss.clients.forEach((client: any) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        address: 'eeg',
                        data: eegData
                    }));
                }
            });

            if ((argv as any).saveToInflux) {
                let writeToInflux = ""

                eegData.forEach((channel, index) => {
                    const channelName = channelNames[index]

                    channel.raw.forEach((sample, index) => {
                        const timeEpochNanos = (startOfEpoch + index * 1000 / samplingRate) * 1000000

                        writeToInflux += `brainwave_raw,channel="${channelName}" eeg=${sample} ${timeEpochNanos}\n`
                    })

                    writeToInflux += `brainwave_epoch,channel="${channelName}" `
                    writeToInflux += `delta=${channel.bandPowers.delta},`
                    writeToInflux += `theta=${channel.bandPowers.theta},`
                    writeToInflux += `alpha=${channel.bandPowers.alpha},`
                    writeToInflux += `beta=${channel.bandPowers.beta},`
                    writeToInflux += `gamma=${channel.bandPowers.gamma},`
                    writeToInflux += ` ${(startOfEpoch + ((samplesPerEpoch / samplingRate) * 1000)) * 1000000}\n`
                })

                console.info(writeToInflux)

                // The actual writing not yet done
            }
        }
    }
    board.stopStream();
    board.releaseSession();
}

runExample();
