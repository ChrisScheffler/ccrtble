'use strict';

const noble = require('@abandonware/noble');
const logDebug = require('debug')('ccrtble');
const CcrtbleDevice = require('./ccrtble-device.js');

const UUID_SERVICE_CCRTBLE = '3e135142654f9090134aa6ff5bb77046';

const getOpt = (options, value, def) => {
	return (options && typeof options[value] !== 'undefined') ? options[value] : def;
};

class Ccrtble {
	constructor() {
		this._devices = {};
		noble.on('stateChange', state => {
			logDebug('adapter changed to to \'%s\'', state);
		});
		noble.on('scanStart', () => {
			logDebug('discovery started');
		});
		noble.on('scanStop', () => {
			logDebug('discovery finished');
		});
	}

	discover(options) {
		const optDuration = getOpt(options, 'duration', 10000);
		const optAddresses = getOpt(options, 'addresses', []);
		const optIgnoreUnknown = getOpt(options, 'ignoreUnknown', false);

		if (isNaN(optDuration)) {
			throw new TypeError('argument [duration] must be a number');
		}

		if (!Array.isArray(optAddresses)) {
			throw new TypeError('argument [addresses] must be an array');
		}

		if (typeof optIgnoreUnknown !== typeof true) {
			throw new TypeError('argument [skipUnknown] must be of type boolean');
		}

		optAddresses.forEach((address, idx) => {
			optAddresses[idx] = CcrtbleDevice.normaliseAddress(address);
		});

		return new Promise(async (resolve, reject) => {
			try {
				await this._ensurePowerOnState();
				await this._startScan(optAddresses, optDuration, optIgnoreUnknown);
				await this._stopScan();
				return resolve(Object.values(this._devices));
			} catch (error) {
				return reject(error);
			}
		});
	}

	/**
	 * Returns a Promise which resolves when the adapter is ready
	 * @private
	 */
	_ensurePowerOnState() {
		return new Promise(resolve => {
			if (noble.state === 'poweredOn') {
				return resolve();
			}

			logDebug('waiting for adapter state change');
			noble.on('stateChange', state => {
				if (state === 'poweredOn') {
					return resolve();
				}
			});
		});
	}

	_checkDiscovered(addresses) {
		let result = true;
		addresses.forEach(address => {
			result &= (this._devices[address] !== undefined);
		});
		return result;
	}

	_startScan(addresses, duration, ignoreUnknown) {
		return new Promise((resolve, reject) => {
			logDebug('starting discovery with %sms duration', duration);
			if (addresses && addresses.length > 0) {
				logDebug('(discovery will be stopped when %o %s found)', addresses, addresses.length === 1 ? 'is' : 'are');
				if (this._checkDiscovered(addresses)) {
					return resolve();
				}
			}

			const timeout = setTimeout(() => {
				logDebug('duration reached, stopping discovery');
				return resolve();
			}, duration);
			noble.on('discover', peripheral => {
				const deviceAddress = CcrtbleDevice.normaliseAddress(peripheral.address);
				if (ignoreUnknown && !addresses.find(addr => addr === deviceAddress)) {
					logDebug('ignoring device with address %s', deviceAddress);
					return;
				}

				if (!peripheral.advertisement.serviceUuids.includes(UUID_SERVICE_CCRTBLE)) {
					return;
				}

				const exisitingDevice = this._devices[deviceAddress];
				if (!exisitingDevice) {
					const newDevice = new CcrtbleDevice(peripheral);
					if (newDevice) {
						this._devices[deviceAddress] = newDevice;
						logDebug('discovered device @ %s', newDevice.address);
						if (addresses && addresses.length > 0 && this._checkDiscovered(addresses)) {
							logDebug('found all requested devices, stopping discovery');
							if (timeout) {
								clearTimeout(timeout);
							}

							return resolve();
						}
					}
				}
			});
			noble.startScanning([UUID_SERVICE_CCRTBLE], false, error => {
				if (error) {
					return reject(error);
				}
			});
		});
	}

	_stopScan() {
		return new Promise(resolve => {
			noble.stopScanning(() => {
				return resolve();
			});
		});
	}
}

module.exports = new Ccrtble();
