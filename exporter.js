const client = require('prom-client');
const express = require('express');

console.log('Starting km200 exporter for Prometheus')
const collectDefaultMetrics = client.collectDefaultMetrics;
const Registry = client.Registry;
const register = new Registry();
collectDefaultMetrics({ gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5], register });
console.log(register.metrics());


// Setup server to Prometheus scrapes:
const server = express();

server.get('/metrics', async (req, res) => {
	try {
		res.set('Content-Type', register.contentType);
		res.end(await register.metrics());
	} catch (ex) {
		res.status(500).end(ex);
	}
});

server.get('/metrics/counter', async (req, res) => {
	try {
		res.set('Content-Type', register.contentType);
		res.end(await register.getSingleMetricAsString('test_counter'));
	} catch (ex) {
		res.status(500).end(ex);
	}
});

const port = process.env.PORT || 3875;
console.log(
	`Server listening to ${port}, metrics exposed on /metrics endpoint`,
);
server.listen(port);