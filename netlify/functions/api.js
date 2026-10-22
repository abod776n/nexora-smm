'use strict';

// Every request (pages, API routes, the Telegram webhook) is handled by the
// same Express app. Netlify's CDN serves public/ assets directly, so only
// dynamic requests reach this function.
const serverless = require('serverless-http');
const { app, ensureReady } = require('../../server');

const handler = serverless(app);

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  await ensureReady();
  return handler(event, context);
};
