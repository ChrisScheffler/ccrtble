'use strict';
const EventEmitter = require('events');
const debug = require('debug');

EventEmitter.prototype._maxListeners = 0;

const UUID_SERVICE_CCRTBLE = '3e135142654f9090134aa6ff5bb77046';
const UUID_CHARACTERISTIC_COMMAND = '3fa4585ace4a3baddb4bb8df8179ea09';
const UUID_CHARACTERISTIC_DATA = 'd0e8434dcd290996af416c90f4e0eb2a';

const timeout = (timeout, promiseFuncs) => {
	const promises = [new Promise(promiseFuncs)];
	if (timeout > 0) {
		promises.push(
			new Promise((resolve, reject) => {
				setTimeout(() => {
					return reject(new Error(`timeout after ${timeout} ms`));
				}, timeout);
			})
		);
	}

	return Promise.race(promises);
};

class CcrtbleDevice {
	constructor(peripheral) {
		this._peripheral = peripheral;
		this._service = undefined;
		this._dataCharacteristic = undefined;
		this._commandCharacteristic = undefined;
		this._dataEvents = new EventEmitter();
		this.name = peripheral.advertisement.localName;
		this.address = CcrtbleDevice.normaliseAddress(peripheral.address);
		this.lastDiscovery = new Date().getTime();
		this.isConnected = false;
		this.logDebug = debug('ccrtble:device:' + this.address);
		peripheral.on('connect', error => {
			if (error) {
				this.logDebug('error while connecting to device: %s', error);
			} else {
				this.logDebug('connected to device');
				this.isConnected = true;
			}
		});
		peripheral.on('disconnect', error => {
			if (error) {
				this.logDebug('error while disconnecting: %s', error);
			} else {
				this.logDebug('disconnected from device');
				this.isConnected = false;
			}
		});
	}

	connect() {
		return timeout(10000, (resolve, reject) => {
			if (this._peripheral.state === 'connected') {
				return resolve();
			}

			this._peripheral.once('connect', async () => {
				try {
					await this._resolveCharacteristics();
					this._dataCharacteristic.on('data', data => this._dataHandler(data));
					this.logDebug('subscribing to data characteristic');
					this._dataCharacteristic.subscribe(err => {
						if (err) {
							return reject(err);
						}

						return resolve();
					});
				} catch (error) {
					reject(error);
				}
			});
			this.logDebug('initiating connection');
			this._peripheral.connect();
		});
	}

	disconnect() {
		return timeout(10000, resolve => {
			if (this._peripheral.state === 'disconnected') {
				return resolve();
			}

			this._peripheral.once('disconnect', () => {
				return resolve();
			});
			this.logDebug('closing connection');
			this._peripheral.disconnect();
		});
	}

	getStatus() {
		const buf = Buffer.alloc(7, 0);
		const now = new Date();
		buf.writeInt8(0x03, 0);
		buf.writeInt8(now.getFullYear() % 100, 1);
		buf.writeInt8(now.getMonth() + 1, 2);
		buf.writeInt8(now.getDate(), 3);
		buf.writeInt8(now.getHours(), 4);
		buf.writeInt8(now.getMinutes(), 5);
		buf.writeInt8(now.getSeconds(), 6);
		return this._sendCommand(buf);
	}

	getInfo() {
		return this._sendCommand(Buffer.of(0x0), 'version');
	}

	setTargetTemperature(temperature) {
		return this._sendCommand(Buffer.of(0x41, temperature * 2));
	}

	setComfortTemperature() {
		return this._sendCommand(Buffer.of(0x43));
	}

	setEcoTemperature() {
		return this._sendCommand(Buffer.of(0x44));
	}

	setBoost(isBoost) {
		return this._sendCommand(Buffer.of(0x45, isBoost ? 0x1 : 0x0));
	}

	_sendCommand(buffer, event = 'status') {
		return timeout(10000, async (resolve, reject) => {
			try {
				await this.connect();
				this._dataEvents.once(event, statusInfo => {
					return resolve(statusInfo);
				});
				await this._writeCharacteristic(this._commandCharacteristic, buffer);
			} catch (error) {
				return reject(error);
			}
		});
	}

	_resolveCharacteristics() {
		return timeout(10000, (resolve, reject) => {
			try {
				this.logDebug('resolving services and characteristic');
				this._peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
					if (error) {
						return reject(error);
					}

					this.logDebug('successfully resolved services and characteristics (%d / %d)', services.length, characteristics.length);
					this._service = this._peripheral.services.find(entry => entry.uuid === UUID_SERVICE_CCRTBLE);
					this._dataCharacteristic = this._service.characteristics.find(entry => entry.uuid === UUID_CHARACTERISTIC_DATA);
					this._commandCharacteristic = this._service.characteristics.find(entry => entry.uuid === UUID_CHARACTERISTIC_COMMAND);
					return resolve();
				});
			} catch (error) {
				return reject(error);
			}
		});
	}

	_writeCharacteristic(characteristic, data) {
		return timeout(10000, (resolve, reject) => {
			try {
				characteristic.write(data, false, err => {
					if (err) {
						return reject();
					}

					this.logDebug('successfully wrote value \'0x%s\' to characteristic %s', data.toString('hex').toUpperCase(), characteristic.uuid.toUpperCase());
					return resolve();
				});
			} catch (error) {
				return reject(error);
			}
		});
	}

	_parseInfo(data) {
		const result = {};
		result.version = data[1];
		result.serial = '';
		for (let n = 4; n < 14; n++) {
			result.serial += String.fromCharCode(data[n] - 0x30);
		}

		return result;
	}

	_parseStatus(data) {
		const result = {};
		const infoType = data[1] & 0xF;
		if (infoType === 0x1) {
			result.mode = data[2] & 0x3;
			result.isBoost = (data[2] & 0x4) !== 0;
			result.isDst = (data[2] & 0x8) !== 0;
			result.isWindowOpen = (data[2] & 0x10) !== 0;
			result.isLocked = (data[2] & 0x20) !== 0;
			result.isLowBattery = (data[2] & 0x80) !== 0;
			result.valve = data[3];
			result.targetTemp = data[5] / 2;
			if (data[2] & 0x02) {
				result.away = {
					day: data[6],
					year: data[7] + 2000,
					min: (data[8] & 0x01) ? 30 : 0,
					hour: data[8] / 2,
					month: data[9]
				};
			}

			result.windowOpen = {
				temp: data[10] / 2,
				time: data[11] * 5
			};

			result.comfortTemp = data[12] / 2;
			result.ecoTemp = data[13] / 2;
			result.tempOffset = (data[14] - 7) / 2;
		} else {
			console.log('unknown status');
		}

		return result;
	}

	_dataHandler(data) {
		console.log(data);
		const cmdCode = data[0];
		switch (cmdCode) {
			case 0x01:
				this.logDebug('received version message');
				this._dataEvents.emit('version', this._parseInfo(data));
				break;
			case 0x02:
				this.logDebug('received status message');
				this._dataEvents.emit('status', this._parseStatus(data));
				break;
			default:
				this.logDebug('unknown code: 0x%s', data.toString('hex'));
		}
	}

	static normaliseAddress(address) {
		return address.replace(/-/g, ':').toLowerCase();
	}
}

module.exports = CcrtbleDevice;
