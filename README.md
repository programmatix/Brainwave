# Brainflow
Connects to your EEG device, streams the EEG data, performs some processing, and outputs the results to websocket clients for visualisation.

The processing includes:
* Bandpass & bandstop filters to filter to interesting brainwave frequencies and remove e.g. 50Hz/60Hz electrical noise.
* FFT analysis.
* Band power analysis (delta, theta, alpha, beta, gamma).
* A cheap blink test that just looks for high amplitude signals, so that epoch can be discarded.

Any board supported by the Brainflow library is supported, including OpenBCI Cyton.