#!/usr/bin/env node
const pkg = require('./package.json');
const request = require('request');
const async = require('async');
const Rijndael = require('rijndael-js');
const buffertrim = require('buffertrim');
const Mqtt = require('mqtt');
const log = require('yalm');
const config = require('./config.js');
require('require-yaml');

var mqttConnected;
var km200Connected;

log.setLevel(config.verbosity);

log.info(pkg.name + ' ' + pkg.version + ' starting');
log.info('mqtt trying to connect', config.url);

var mqtt = Mqtt.connect(config.url,
  {
    will: { topic: config.name + '/connected', payload: '0', retain: true },
    rejectUnauthorized: !config.insecure
  }
);

mqtt.on('connect', function () {
  mqttConnected = true;
  log.info('Connected to mqtt');
  log.info('mqtt connected', config.url);
  mqtt.publish(config.name + '/connected', '1', { retain: true });

  log.info('mqtt subscribe', config.name + '/set/#');
  mqtt.subscribe(config.name + '/set/#');

  checkKM200();
  setInterval(checkKM200, 60000);
});

mqtt.on('close', function () {
  if (mqttConnected) {
    mqttConnected = false;
    log.info('mqtt closed ' + config.url);
  }
});

mqtt.on('error', function (err) {
  log.error('mqtt', err);
});

log.info('Config file: ' + config.config);
var measurements = require(config.config).measurements;
log.debug(measurements);
var key = Buffer.from(config.passcode, 'hex');
log.debug(key);
var desEcb = new Rijndael(key, 'ecb');

var km200host = config.km200;
log.info(km200host);

var writables = {};
var meta = {};

function mnemonizeWritable(result) {
  if (result.writeable === 1) {
    log.debug('mnemonizeWritable', result);
    if (writables[result.id] === undefined) {
      storeWritable(result);
    }
  }
}

function storeWritable(result) {
  if (result.allowedValues) {
    log.info('Writable: ' + result.id + ' (' + result.type + '): ' + JSON.stringify(result.allowedValues));
  } else if (result.minValue) {
    log.info('Writable: ' + result.id + ' (' + result.type + '): ' + result.minValue + ' - ' + result.maxValue);
  } else {
    return;
  }
  var writable = {
    valueType: result.type,
    minValue: result.minValue,
    maxValue: result.maxValue,
    allowedValues: result.allowedValues
  };
  writables[result.id] = writable;
}

function mnemonizeMeta(result) {
  log.debug('mnemonizeMeta', result);
  if (!meta[result.id]) {
    publishMeta(result);
    meta[result.id] = true;
  }
}

function publishMeta(result) {
  if (typeof (result.id) === 'string') {
    if (endsWith(result.id, 'flameCurrent')) {
      result.unitOfMeasure = 'µA';
    }
    var topic = 'km200/meta' + result.id;
    var metaData = {
      native: JSON.parse(JSON.stringify(result))
    };
    metaData.native.value = undefined;
    metaData.native.id = undefined;
    mqtt.publish(topic, JSON.stringify(metaData), { retain: true }, function () {
      log.debug('meta', topic, metaData);
    });
  }
}

function endsWith(str, suffix) {
  return str.indexOf(suffix, str.length - suffix.length) !== -1;
}

mqtt.on('message', (topic, message) => {
  log.info(topic, message.toString())
  const topicPrefix = config.name + '/set/';
  if (topic.startsWith(topicPrefix)) {
    let url = topic.substring(topicPrefix.length - 1);
    let value = message.toString();
    let writable = writables[url];
    if (writable) {
      if ((writable.valueType === 'stringValue' && writable.allowedValues.indexOf(value) !== -1) ||
        (writable.valueType === 'floatValue' && parseFloat(value) >= writable.minValue && parseFloat(value) <= writable.maxValue)) {
        log.info('WRITE: ' + value);
        const postValue = desEcb.encrypt(JSON.stringify({
          value: writable.valueType === 'stringValue' ? value : parseFloat(value)
        }),128).toString('base64');
        var options = {
          url: 'http://' + km200host + url,
          body: postValue,
          headers: {
            'Content-type': 'application/json',
            'User-Agent': 'TeleHeater/2.2.3'
          }
        };
        request.post(options, function (error, response, body) {
          if (!error) {
            getKM200(url, function done() { });
          }
          //log.info(error, response);
        });
      } else {
        log.info('Invalid value: ' + value);
      }
    } else {
      log.info(url + ' not writable!');
    }
  }
});

function getKM200(url, done) {
  var options = {
    url: 'http://' + km200host + url,
    headers: {
      'Content-type': 'application/json',
      'User-Agent': 'TeleHeater/2.2.3'
    }
  };
  request.get(options, function (error, response, body) {
    if (!error && response.statusCode === 200) {
      if (!km200Connected) {
        km200Connected = true;
        mqtt.publish(config.name + '/connected', '2', { retain: true });
      }
      const bodyBuffer = Buffer.from(body, 'base64');
      const dataBuffer = buffertrim.trimEnd(Buffer.from(desEcb.decrypt(bodyBuffer, 128)));
      const result = JSON.parse(dataBuffer.toString());
      mnemonizeWritable(result);
      mnemonizeMeta(result);
      var topic = 'km200/status' + result.id;
      var state = {
        ts: Math.floor(new Date() / 1000),
        val: result.value,
        km200_unitOfMeasure: result.unitOfMeasure
      };
      mqtt.publish(topic, JSON.stringify(state), { retain: true }, function () {
        log.debug(topic, state);
      });
      done(null);
    } else {
      done(null);
    }
  });
}

function checkKM200() {
  log.debug('Start checking');
  async.eachSeries(measurements,
    function (measurement, cb) {
      getKM200(measurement.url, function (done) {
        cb(done);
      });
    },
    function (err, result) {
      if (err) {
        console.error(err);
      } else {
        console.log('Completed iteration');
      }
    }
  );
}
