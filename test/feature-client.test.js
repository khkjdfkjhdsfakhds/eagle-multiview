'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EagleClient } = require('../lib/eagle-client');
test('logical folder move preserves explicit parent and color through V2 without renaming', async () => {
  const client = new EagleClient();
  client.request = async (route, options) => {
    assert.equal(route, '/api/v2/folder/update');
    assert.deepEqual(options.body, { id: 'folder-a', parent: null, iconColor: 'red' });
    return true;
  };
  assert.equal(await client.moveFolder('folder-a', { parent: null, iconColor: 'red' }), true);
});

test('site image import uses official URL add and preserves page source and chosen folder', async () => {
  const client = new EagleClient();
  client.request = async (route, options) => {
    assert.equal(route, '/api/v2/item/add');
    assert.deepEqual(options.body, { url: 'https://cdna.artstation.com/image.jpg', name: 'Fixture', website: 'https://www.artstation.com/artwork/aa', folders: ['target'] });
    return {id:'new-item'};
  };
  assert.deepEqual(await client.addSiteAsset({url:'https://cdna.artstation.com/image.jpg',name:'Fixture',website:'https://www.artstation.com/artwork/aa'},'target'), {id:'new-item'});
});
