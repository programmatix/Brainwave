import {BoardIds, BoardShim, complex, DataFilter, DetrendOperations, FilterTypes, WindowOperations} from 'brainflow';
import {Server, WebSocket} from 'ws'
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';
import {config} from 'dotenv';
import {InfluxDB, Point, WriteApi} from '@influxdata/influxdb-client';
import mqtt from 'mqtt';


config();

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
    channelName: string,
    raw: number[]
    filtered: number[]
    fft: complex[]
    bandPowers: BandPowers
    overThresholdIndices: number[]
}

async function runBrainflow(): Promise<void> {
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
        .option('waitForCommands', {
            alias: 'w',
            describe: 'Instead of immediately connecting to the board, waits for directions over websocket.  Useful for headless servers',
            type: 'boolean',
            default: false
        })
        .option('serialPort', {
            alias: 'sp',
            describe: 'Serial port e.g. /dev/ttyUSB0 (Linux) or COM11 (Windows)',
            type: 'string'
        })
        .option('websocketPort', {
            alias: 'wp',
            describe: 'Websocket port.  Clients can subscribe for updates and send commands.',
            type: 'number',
            default: 8080
        })
        .option('saveToBrainflowFile', {
            alias: 'f',
            describe: "Save the raw unprocessed data to file, in Brainflow's format",
            type: 'string',
        })
        .option('mqttUrl', {
            describe: 'MQTT URL',
            type: 'string'
        })
        .option('mqttUsername', {
            describe: 'MQTT username',
            type: 'string'
        })
        .option('mqttPassword', {
            describe: 'MQTT password',
            type: 'string'
        })
        .option('saveToInflux', {
            alias: 'i',
            describe: 'Save data to InfluxDB',
            type: 'boolean',
            default: false
        })
        .parse();

    const serialPort = (argv as any).serialPort as string;
    const websocketPort = (argv as any).websocketPort as number;
    const saveToInflux = (argv as any).saveToInflux as boolean
    const saveToBrainflowFile: string | undefined = (argv as any).saveToBrainflowFile
    const mqttUrl: string | undefined = (argv as any).mqttUrl
    const mqttUsername: string | undefined = (argv as any).mqttUsername
    const mqttPassword: string | undefined = (argv as any).mqttPassword
    const waitForCommands: boolean | undefined = (argv as any).waitForCommands

    let wss: Server | undefined = undefined
    let mqttClient: mqtt.MqttClient | undefined = undefined
    let influxDb: InfluxDB | undefined = undefined
    let influxDbWriteApi: WriteApi | undefined = undefined
    let board: BoardShim | undefined = undefined

    if (websocketPort) {
        console.info(`Opening websocket server on port ${websocketPort}`)
        wss = new WebSocket.Server({port: websocketPort});

        wss.on('connection', (ws: WebSocket) => {
            ws.on('message', (message: string) => {
                try {
                    const msg = JSON.parse(message);
                    console.info(`Command received: ${message}`)
                    switch (msg.command) {
                        case 'start':
                            log('Starting');
                            connectToBoard()
                            break;
                        case 'stop':
                            log('Stopping recording');
                            if (board) {
                                board.stopStream();
                                board.releaseSession();
                                board = undefined
                            }
                            break;
                        case 'quit':
                            log('Quitting');
                            done = true
                            break;
                        default:
                            console.warn('Unknown command');
                    }
                    sendToWebsocketClients(JSON.stringify({
                        address: 'log',
                        status: 'success',
                        message: `Command '${msg.command}' processed`
                    }));
                } catch (error) {
                    console.error('Error processing message:', error);
                    sendToWebsocketClients(JSON.stringify({
                        address: 'log',
                        status: 'error',
                        message: `Command '${message}' failed`
                    }));
                }
            })
        })
    }

    function sendToWebsocketClients(message: string) {
        if (wss) {
            //console.info(`Sending to ${wss.clients.size} clients`)
            wss.clients.forEach((client: any) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(message);
                }
            });
        }
    }

    function log(message: string) {
        sendToWebsocketClients(JSON.stringify({
            address: 'log',
            message: message
        }));
        console.info(message)
    }

    if (mqttUrl) {
        const options = {
            username: mqttUsername,
            password: mqttPassword
        };

        log(`Connecting to MQTT on ${mqttUrl} ${mqttUsername}`)
        mqttClient = mqtt.connect(mqttUrl, options);
        mqttClient.on('connect', () => {
            log('MQTT connected');
        });

        mqttClient.on('error', (err) => {
            log('MQTT connection error: ' + err);
        });
    }

    if (process.env.INFLUXDB_URL) {
        influxDb = new InfluxDB({
            url: process.env.INFLUXDB_URL as string,
            token: process.env.INFLUXDB_TOKEN as string
        });
        influxDbWriteApi = influxDb.getWriteApi(process.env.INFLUXDB_ORG as string, process.env.INFLUXDB_BUCKET as string);
    }

    const channelNames = (argv as any).channels as string[];

    BoardShim.setLogLevel(0);
    BoardShim.releaseAllSessions();
    const boardId = (argv as any).boardId as BoardIds;
    const eegChannels = BoardShim.getEegChannels(boardId).slice(0, channelNames.length);
    log(`EEG Channels: ${eegChannels}`)
    const samplingRate = BoardShim.getSamplingRate(boardId);

    function connectToBoard() {
        log("Connecting to board")
        board = new BoardShim(boardId, {serialPort: serialPort});
        log("Connected to board")
        board.prepareSession();
        log("Starting stream")
        board.startStream();
        // if (saveToBrainflowFile) {
        const filename = (new Date()).toLocaleString().replace(/\//g, "-").replace(/ /g, "-").replace(/,/g, "-").replace(/:/g, "-") + ".brainflow.csv";
        log("Writing to file " + filename)
        board.addStreamer(`file://${filename}:w`)
        // }
        log("Stream started")
    }

    if (!waitForCommands) {
        // connectToBoard()
    }

    let sampleBuffer: number[][] = Array(eegChannels.length).fill(null).map(() => []);

    let startOfEpoch = new Date().getTime();
    let samplesPerEpoch = samplingRate
    let done = false

    while (!done) {
        await sleep(samplesPerEpoch);

        //log('Collecting samples board=' + board)

        if (board !== undefined) {
            const allData = board.getBoardData();

            eegChannels.forEach((channel, index) => {
                sampleBuffer[index] = sampleBuffer[index].concat(allData[channel]);
            });

            // Collect until we have enough samples.
            const numSamples = sampleBuffer[eegChannels[0]].length
            log(`Collected ${numSamples} samples`)

            if (numSamples >= samplesPerEpoch) {
                const eegData: PerChannel[] = []
                eegChannels.forEach((channel, index) => {
                    const channelName = channelNames[index]
                    const raw = sampleBuffer[index].slice(0, samplesPerEpoch);
                    // console.info(`Processing ${raw.length} samples from ${sampleBuffer[index].length}`)

                    sampleBuffer[index] = sampleBuffer[index].slice(samplesPerEpoch);

                    const filtered = [...raw]

                    if (filtered.some(value => value === undefined)) {
                        console.warn('Filtered data contains undefined values');
                        eegData.push({
                            channelIdx: index,
                            channelName: channelName,
                            raw: raw,
                            filtered: filtered,
                            fft: [],
                            bandPowers: {
                                delta: 0,
                                theta: 0,
                                alpha: 0,
                                beta: 0,
                                gamma: 0
                            },
                            overThresholdIndices: []
                        })
                        return
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

                    eegData.push({
                        channelIdx: index,
                        channelName: channelName,
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
                    })
                });

                startOfEpoch = new Date().getTime();

                if (mqttClient) {
                    mqttClient.publish('brainwave/eeg', JSON.stringify(eegData.map(channel => {
                        return {
                            channel: channel.channelName,
                            delta: channel.bandPowers.delta,
                            theta: channel.bandPowers.theta,
                            alpha: channel.bandPowers.alpha,
                            beta: channel.bandPowers.beta,
                            gamma: channel.bandPowers.gamma
                        }
                    })));
                }

                sendToWebsocketClients(JSON.stringify({
                    address: 'eeg',
                    data: eegData
                }));

                if (influxDbWriteApi) {
                    let writeToInflux: Point[] = []

                    eegData.forEach((channel, index) => {
                        const channelName = channelNames[index]

                        const writeRaw = false
                        if (writeRaw) {
                            channel.raw.forEach((sample, index) => {
                                const timeEpochNanos = (startOfEpoch + index * 1000 / samplingRate) * 1000000

                                writeToInflux.push(new Point('brainwave_raw')
                                    .tag('channel', channelName)
                                    .floatField('eeg', sample)
                                    .timestamp(timeEpochNanos));
                            })
                        }

                        const epochPoint = new Point('brainwave_epoch')
                            .tag('channel', channelName)
                            .floatField('delta', channel.bandPowers.delta)
                            .floatField('theta', channel.bandPowers.theta)
                            .floatField('alpha', channel.bandPowers.alpha)
                            .floatField('beta', channel.bandPowers.beta)
                            .floatField('gamma', channel.bandPowers.gamma)
                            .timestamp((startOfEpoch + ((samplesPerEpoch / samplingRate) * 1000)) * 1000000);

                        writeToInflux.push(epochPoint);
                    })

                    log(`Saving ${writeToInflux.length} points to Influx`)
                    influxDbWriteApi.writePoints(writeToInflux)
                }
            }
        }
    }
    if (board !== undefined) {
        board!.stopStream();
        board!.releaseSession();
    }
    log('Done')
}

runBrainflow();
