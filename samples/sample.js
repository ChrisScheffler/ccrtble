'use strict';

const ccrtble = require('../lib/ccrtble.js');

const discoverOptions = {
	addresses: ['00:1a:22:0e:54:19'],
	ignoreUnknown: true,
	duration: 30000
};

(async function () {
	console.log('> scanning for a max of %s seconds', discoverOptions.duration / 1000);
	const devices = await ccrtble.discover(discoverOptions);
	const device = devices.find(entry => entry.address === '00:1a:22:0e:54:19');
	if (device) {
		console.log(await device.getInfo());
		console.log(await device.getStatus());
		await device.disconnect();
	} else {
		console.log('not found');
	}
})();
