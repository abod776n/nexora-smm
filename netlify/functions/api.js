'use strict';

// Every request (pages, API routes, the Telegram webhook) is handled by the
// same Express app. Netlify's CDN serves public/ assets directly, so only
// dynamic requests reach this function.
const serverless = require('serverless-http');
const { app, ensureReady } = require('../../server');

// Receipt images are served as real bytes; without this the function base64-
// encodes text and the browser gets a broken picture.
const handler = serverless(app, {
  binary: ['image/*', 'application/pdf', 'application/octet-stream'],
});

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  await ensureReady();
  return handler(event, context);
};
