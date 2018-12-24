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
		return timeout(10000, async (resolve, reject) => {
			this.logDebug('getting status information');
			try {
				await this.connect();
				const buf = Buffer.alloc(7, 0);
				const now = new Date();
				buf.writeInt8(0x03, 0);
				buf.writeInt8(now.getFullYear() % 100, 1);
				buf.writeInt8(now.getMonth() + 1, 2);
				buf.writeInt8(now.getDate(), 3);
				buf.writeInt8(now.getHours(), 4);
				buf.writeInt8(now.getMinutes(), 5);
				buf.writeInt8(now.getSeconds(), 6);
				this._dataEvents.once('status', statusInfo => {
					return resolve(statusInfo);
				});
				await this._writeCharacteristic(this._commandCharacteristic, buf);
			} catch (error) {
				return reject(error);
			}
		});
	}

	_resolveCharacteristics() {
		return timeout(10000, (resolve, reject) => {
			try {
				this.logDebug('resolving characteristic');
				this._peripheral.discoverAllServicesAndCharacteristics((error, services, characteristics) => {
					if (error) {
						return reject(error);
					}
					this.logDebug('successfully resolved characteristics (%d/%d)', services.length, characteristics.length);
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

	_parseStatus(data) {
		const result = {};
		const infoType = data[1] & 0xF;
		if (infoType === 0x1) {
			result.boostMode = (data[2] & 0x4) !== 0;
			result.mode = data[2] & 0x3;
			result.dst = (data[2] & 0x8) !== 0;
			result.windowOpen = (data[2] & 0x10) !== 0;
			result.locked = (data[2] & 0x20) !== 0;
			result.lowBattery = (data[2] & 0x80) !== 0;
			result.valve = data[3];
			result.targetTemp = data[5] / 2.0;
		} else if (infoType === 2) {
			console.log('unknown status');
		}
		return result;
	}

	_dataHandler(data) {
		const cmdCode = data[0];
		switch (cmdCode) {
			case 0x01:
				this.logDebug('received version message');
				this._dataEvents.emit('version', data[1]);
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
