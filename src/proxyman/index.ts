/**
 * Proxyman sub-package — Network interception and SDUI payload validation.
 *
 * Responsible for:
 *   • Retrieving HTTP transaction logs from Proxyman
 *   • Filtering transactions by URL path (SDUI, analytics, etc.)
 *   • Validating SDUI response payloads against expected schemas
 */

export { ProxymanWrapper } from './wrapper.js';
export { PayloadValidator } from './validator.js';

import { ProxymanWrapper } from './wrapper.js';
export const proxymanWrapper = new ProxymanWrapper();
