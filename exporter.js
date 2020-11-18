const client = require('prom-client');
const express = require('express');
const Rijndael = require('rijndael-js');
const buffertrim = require('buffertrim');
const fs = require('fs');
const yaml = require('yaml');
const pkg = require('./package.json');
const axios = require('axios');
const { setIntervalAsync } = require('set-interval-async/dynamic')

console.log('Starting km200 exporter for Prometheus')
const collectDefaultMetrics = client.collectDefaultMetrics;
const Registry = client.Registry;
collectDefaultMetrics({ gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5]});

console.log('Staritng prometheus exporter for km200 api');

// Setup server to Prometheus scrapes:
const server = express();

const config = require('yargs')
    .env('KM200')
    .usage(pkg.name + ' ' + pkg.version + '\n' + pkg.description + '\n\nUsage: $0 [options]')
    .describe('p', 'KM200 passcode')
    .describe('l', 'PORT to expose /measurements')
    .describe('k', 'KM200 host')
    .describe('c', 'KM200 measurment file')
    .describe('h', 'show help')
    .alias({
        'h': 'help',
        'k': 'km200',
        'p': 'passcode',
        'c': 'config',
        'v': 'verbosity',
        'l': 'port'
    })
    .default({
        'c': './config.yml',
        'l': 3875
    })
    .version()
    .help('help')
    .argv;

const key = Buffer.from(config.passcode, 'hex');
const desEcb = new Rijndael(key, 'ecb');   

const measurementsFile = fs.readFileSync(config.config, 'utf8')
const measurements = yaml.parse(measurementsFile).measurements;
const callbacks = [];
for (const measurement of measurements) {
    const url = measurement.url;
    const type = measurement.type;
    const metricName = 'km200' + url.replace(/\//g,"_")
    if (type) {
        console.log('Configuring measurement for url', metricName);
        const counter = new client.Gauge({
            name: metricName,
            help: measurement.help || 'help missing'
        });
        callbacks.push(async () => {
            console.log(`Query ${url}`);
            const result = await queryKM200(url);
            console.log(`Result ${JSON.stringify(result)}`);
            if (result) {
                if (result.type == 'floatValue') {
                    counter.set(result.value);
                } else if (result.type == 'stringValue') {
                    counter.set(result.value=='on'?1:0);
                }
            } else {
                console.log('Error - Value is either empty or of unexpected type');
            }
        });
    } else {
        console.log('Type is not set, ignoring %j', measurement);
    }
}

server.get('/metrics', async (req, res) => {
    try {
        res.set('Content-Type', client.register.contentType);
        res.end(await client.register.metrics());
    } catch (ex) {
        console.error(ex);
        res.status(500).end(ex);
    }
});

(async () => {
    try {
        console.log('Doing initial refresh of the metrics');
        await refreshMetrics();
        const port = process.env.PORT || config.port;
        console.log(
            `Server listening to ${port}, metrics exposed on /metrics endpoint`,
        );
        server.listen(port);
        console.log('Starting polling interval of 60 seconds');
        setIntervalAsync(refreshMetrics, 60000);
    } catch (e) {
        console.log(e);
    }
})();

async function refreshMetrics() {
    console.log(`Starting refresh cycle at ${new Date()}`);
    for(const cb of callbacks) {
        await cb();
    }
    console.log(`Refresh cycle ended at ${new Date()}`);
}

async function queryKM200(url) {
    const options = {
        method: 'get',
        url,
        baseURL: `http://${config.km200}`,
        headers: {
            'Content-type': 'application/json',
            'User-Agent': 'TeleHeater/2.2.3'
        }
    };
    const response = await axios(options);
    if (response.status == 200) {
        const bodyBuffer = Buffer.from(response.data, 'base64');
        const dataBuffer = buffertrim.trimEnd(Buffer.from(desEcb.decrypt(bodyBuffer, 128)));
        const result = JSON.parse(dataBuffer.toString());
        return result;
    } else {
        console.error(`Failed to request ${url} - error ${JSON.stringify(response, null, '\n')}`);
        return null;
    }
}