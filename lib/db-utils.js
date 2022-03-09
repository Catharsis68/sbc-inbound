const assert = require('assert');
const CIDRMatcher = require('cidr-matcher');
const {parseUri} = require('drachtio-srf');
const {normalizeDID} = require('./utils');

const sqlSelectAllCarriersForAccountByRealm =
`SELECT sg.sip_gateway_sid, sg.voip_carrier_sid, vc.name, vc.account_sid,  
vc.application_sid, sg.inbound, sg.outbound, sg.is_active, sg.ipv4, sg.netmask  
FROM sip_gateways sg, voip_carriers vc, accounts acc 
WHERE acc.sip_realm = ? 
AND vc.account_sid = acc.account_sid 
AND sg.voip_carrier_sid = vc.voip_carrier_sid`;

const sqlSelectAllCarriersForSPByRealm =
`SELECT sg.sip_gateway_sid, sg.voip_carrier_sid, vc.name, vc.account_sid,  
vc.application_sid, sg.inbound, sg.outbound, sg.is_active, sg.ipv4, sg.netmask  
FROM sip_gateways sg, voip_carriers vc, accounts acc 
WHERE acc.sip_realm = ? 
AND vc.service_provider_sid = acc.service_provider_sid  
AND vc.account_sid IS NULL 
AND sg.voip_carrier_sid = vc.voip_carrier_sid`;

const sqlSelectAllGatewaysForSP =
`SELECT sg.sip_gateway_sid, sg.voip_carrier_sid, vc.name, vc.service_provider_sid,  
vc.application_sid, sg.inbound, sg.outbound, sg.is_active, sg.ipv4, sg.netmask  
FROM sip_gateways sg, voip_carriers vc
WHERE sg.voip_carrier_sid = vc.voip_carrier_sid 
AND vc.service_provider_sid IS NOT NULL 
AND vc.is_active = 1`;

const sqlSelectAllGatewaysForAccountBySourceAddress =
`SELECT sg.sip_gateway_sid, sg.voip_carrier_sid, vc.name, vc.account_sid,  
vc.application_sid, sg.inbound, sg.outbound, sg.is_active, sg.ipv4, sg.netmask  
FROM sip_gateways sg, voip_carriers vc
WHERE sg.voip_carrier_sid = vc.voip_carrier_sid 
AND sg.ipv4 = ? 
AND sg.inbound = 1 
AND vc.account_sid IS NOT NULL 
AND vc.is_active = 1`;

const sqlCarriersForAccountBySid =
`SELECT sg.sip_gateway_sid, sg.voip_carrier_sid, vc.name, vc.account_sid,  
vc.application_sid, sg.inbound, sg.outbound, sg.is_active, sg.ipv4, sg.netmask  
FROM sip_gateways sg, voip_carriers vc, accounts acc 
WHERE acc.account_sid = ? 
AND vc.account_sid = acc.account_sid 
AND sg.voip_carrier_sid = vc.voip_carrier_sid`;

const sqlAccountByRealm = 'SELECT * from accounts WHERE sip_realm = ?';
const sqlAccountBySid = 'SELECT * from accounts WHERE account_sid = ?';

const sqlQueryApplicationByDid = `
SELECT * FROM phone_numbers 
WHERE number = ? 
AND voip_carrier_sid = ?`;

const sqlSelectOutboundGatewayForCarrier = `
SELECT ipv4, port, e164_leading_plus  
FROM sip_gateways sg, voip_carriers vc 
WHERE sg.voip_carrier_sid = ? 
AND sg.voip_carrier_sid = vc.voip_carrier_sid 
AND outbound = 1`;

const gatewayMatchesSourceAddress = (source_address, gw) => {
  if (32 === gw.netmask && gw.ipv4 === source_address) return true;
  if (gw.netmask < 32) {
    const matcher = new CIDRMatcher([`${gw.ipv4}/${gw.netmask}`]);
    return matcher.contains(source_address);
  }
  return false;
};

module.exports = (srf, logger) => {
  const {pool}  = srf.locals.dbHelpers;
  const pp = pool.promise();

  const getOutboundGatewayForRefer = async(voip_carrier_sid) => {
    try {
      const [r] = await pp.query(sqlSelectOutboundGatewayForCarrier, [voip_carrier_sid]);
      if (0 === r.length) return null;

      /* if multiple, prefer a DNS name */
      const hasDns = r.find((row) => row.ipv4.match(/^[A-Za-z]/));
      return hasDns || r[0];
    } catch (err) {
      logger.error({err}, 'getOutboundGatewayForRefer');
    }
  };

  const getApplicationForDidAndCarrier = async(req, voip_carrier_sid) => {
    const did = normalizeDID(req.calledNumber);

    try {
      const [r] = await pp.query(sqlQueryApplicationByDid, [did, voip_carrier_sid]);
      if (0 === r.length) return null;
      return r[0].application_sid;
    } catch (err) {
      logger.error({err}, 'getApplicationForDidAndCarrier');
    }
  };

  const wasOriginatedFromCarrier = async(req) => {
    const failure = {fromCarrier: false};
    const uri = parseUri(req.uri);
    const isDotDecimal = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(uri.host);

    logger.debug(`wasOriginatedFromCarrier: realm ${uri.host}, source ${req.source_address}`);

    /* hosted jambonz -- accounts must configure carriers to send to their sip realm */
    if (isDotDecimal && process.env.JAMBONES_HOSTING) {
      if (!process.env.SBC_ACCOUNT_SID) {
        logger.debug(`wasOriginatedFromCarrier: hosted jambonz  ${process.env.SBC_ACCOUNT_SID}`);
        return failure;
      }

      /* exception: dedicated SBC */
      const [r] = await pp.query(sqlCarriersForAccountBySid,
        [process.env.SBC_ACCOUNT_SID, req.source_address, req.source_port]);
      if (0 === r.length) {
        logger.debug(
          `wasOriginatedFromCarrier: hosted jambonz (deicated sbc) no carriers for ${process.env.SBC_ACCOUNT_SID}`);
        return failure;
      }
      return {
        fromCarrier: true,
        gateway: r[0],
        account_sid: process.env.SBC_ACCOUNT_SID
      };
    }

    if (!isDotDecimal) {
      /* get all the carriers and gateways for the account owning this sip realm */
      const [gwAcc] = await pp.query(sqlSelectAllCarriersForAccountByRealm, uri.host);
      const [gwSP] = gwAcc.length ? [[]] : await pp.query(sqlSelectAllCarriersForSPByRealm, uri.host);
      const gw = gwAcc.concat(gwSP);
      const selected = gw.find(gatewayMatchesSourceAddress.bind(null, req.source_address));
      if (selected) {
        const [a] = await pp.query(sqlAccountByRealm, uri.host);
        if (1 === a.length) {
          logger.debug({
            realm: uri.host,
            source_address: req.source_address,
            account_sid:  a[0].account_sid
          }, 'wasOriginatedFromCarrier: (true) found carrier and account');
          return {
            fromCarrier: true,
            gateway: selected,
            account_sid: a[0].account_sid,
            application_sid: selected.application_sid,
            account: a[0]
          };
        }
      }
      if (process.env.JAMBONES_HOSTING) {
        logger.debug('wasOriginatedFromCarrier: unknown realm (hosted jambonz');
        return failure;
      }
    }

    /* this is a self-hosted system (not a hosted jambonz system)
      the req.uri is either an IP or a realm we did not find */
    /* check for a carrier at the service provider level with an inbound gw = source IP */
    const [gw] = await pp.query(sqlSelectAllGatewaysForSP);
    const matches = gw.filter(gatewayMatchesSourceAddress.bind(null, req.source_address));
    if (matches.length) {
      /* we have one or more carriers that match.  Now we need to find one with a provisioned phone number */
      const vc_sids = matches.map((m) => `'${m.voip_carrier_sid}'`).join(',');
      const did = normalizeDID(req.calledNumber);
      const sql =  `SELECT * FROM phone_numbers WHERE number = ${did} AND voip_carrier_sid IN (${vc_sids})`;
      logger.debug({
        matches, sql, did, vc_sids
      }, 'wasOriginatedFromCarrier: looking up DID for service provider carrier');

      const [r] = await pp.query(sql);
      if (0 === r.length) {
        /* came from a carrier, but number is not provisioned..
            check if we only have a single account, otherwise we have no
            way of knowing which account this is for
        */
        const [r] = await pp.query('SELECT count(*) as count from accounts where service_provider_sid = ?',
          matches[0].service_provider_sid);
        if (r[0].count !== 1) {
          logger.debug('wasOriginatedFromCarrier: call from carrier associated with SP, no DID mapping though');
          return {fromCarrier: true};
        }
        else {
          const [accounts] = await pp.query('SELECT * from accounts where service_provider_sid = ?',
            matches[0].service_provider_sid);
          logger.debug('wasOriginatedFromCarrier: call from carrier associated with SP, with DID mapping');
          return {
            fromCarrier: true,
            gateway: matches[0],
            account_sid: accounts[0].account_sid,
            account: accounts[0]
          };
        }
      }
      const gateway = matches.find((m) => m.voip_carrier_sid === r[0].voip_carrier_sid);
      const [accounts] = await pp.query(sqlAccountBySid, r[0].account_sid);
      assert(accounts.length);
      return {
        fromCarrier: true,
        gateway,
        account_sid: r[0].account_sid,
        application_sid: r[0].application_sid,
        account: accounts[0]
      };
    }

    /* not a service provider level carrier -- try account-level with inbound gw = source IP */
    const [gwAccount] = await pp.query(sqlSelectAllGatewaysForAccountBySourceAddress, req.source_address);
    if (gwAccount.length) {
      logger.debug({gwAccount}, 'wasOriginatedFromCarrier: call came from account level carrier');
      const accountSet = new Set();
      gwAccount.forEach((gw) => accountSet.add(gw.account_sid));
      if (accountSet.size > 1) {
        logger.info({accounts: accountSet},
          `wasOriginatedFromCarrier: ${accountSet.size} accounts found with ${req.source_address} inbound gw`);
        return failure;
      }
      const [accounts] = await pp.query('SELECT * from accounts where account_sid = ?',
        gwAccount[0].account_sid);
      logger.debug('wasOriginatedFromCarrier: call from carrier associated with account');
      return {
        fromCarrier: true,
        gateway: gwAccount[0],
        account_sid: accounts[0].account_sid,
        account: accounts[0]
      };
    }

    logger.info(`wasOriginatedFromCarrier: no carrier found for host: ${req.uri} source: ${req.source_address}`);
    return failure;
  };

  return {
    wasOriginatedFromCarrier,
    getApplicationForDidAndCarrier,
    getOutboundGatewayForRefer
  };
};
