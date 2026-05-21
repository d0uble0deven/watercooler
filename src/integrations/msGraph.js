'use strict';

// Microsoft Graph API client
//
// Provides a single authenticated client for all Microsoft 365 API calls
// (calendar reads, event creation, Teams meeting generation).
//
// Uses app-only authentication (ClientSecretCredential) — no per-user login
// required. IT grants the app permission once via Azure AD app registration.
// See docs/OUTLOOK_INTEGRATION.md — Part 1 for the IT setup steps.
//
// Returns null (never throws) when credentials are missing or incomplete,
// so callers can degrade gracefully without crashing the app.

const { Client }                 = require('@microsoft/microsoft-graph-client');
const { ClientSecretCredential } = require('@azure/identity');
const config                     = require('../config');

/**
 * Returns a configured Microsoft Graph API client, or null if Azure
 * credentials are not set in .env.
 *
 * The client is created fresh on each call — lightweight for an internal
 * tool with low API call frequency (once per matching round).
 */
function getGraphClient() {
  if (!config.azureTenantId || !config.azureClientId || !config.azureClientSecret) {
    return null;
  }

  const credential = new ClientSecretCredential(
    config.azureTenantId,
    config.azureClientId,
    config.azureClientSecret
  );

  // Use a simple callback-based auth provider so we don't need the
  // @microsoft/microsoft-graph-client/authProviders/azureTokenCredentials
  // sub-path, which has additional peer-dependency requirements.
  const client = Client.init({
    authProvider: async (done) => {
      try {
        const tokenResponse = await credential.getToken(
          'https://graph.microsoft.com/.default'
        );
        done(null, tokenResponse.token);
      } catch (err) {
        done(err, null);
      }
    },
  });

  return client;
}

/**
 * Returns true only when all three Azure credentials are present in config.
 * Does NOT verify that they're valid — use calendarStatus for that.
 */
function hasAzureCredentials() {
  return !!(config.azureTenantId && config.azureClientId && config.azureClientSecret);
}

module.exports = { getGraphClient, hasAzureCredentials };
