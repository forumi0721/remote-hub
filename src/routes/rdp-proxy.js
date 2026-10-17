'use strict';

const tls = require('tls');
const net = require('net');
const crypto = require('crypto');
const configManager = require('../config');

// ── RDCleanPath ASN.1 DER Constants ──
const VERSION_1 = 3390; // 3389 + 1

// ASN.1 tag constants
const TAG_SEQUENCE = 0x30;
const TAG_INTEGER = 0x02;
const TAG_OCTET_STRING = 0x04;
const TAG_UTF8STRING = 0x0c;

// Context-specific EXPLICIT tags used by RDCleanPath
const TAG_CTX = (n) => 0xa0 + n;

// ────────────────────────────────────────────────────
// ASN.1 DER Low-Level Helpers
// ────────────────────────────────────────────────────

function derEncodeLength(length) {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes = [];
  let temp = length;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derWrap(tag, content) {
  const len = derEncodeLength(content.length);
  return Buffer.concat([Buffer.from([tag]), len, content]);
}

function derEncodeInteger(value) {
  if (value === 0) {
    return derWrap(TAG_INTEGER, Buffer.from([0]));
  }
  const bytes = [];
  let temp = value;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  if (bytes[0] & 0x80) {
    bytes.unshift(0);
  }
  return derWrap(TAG_INTEGER, Buffer.from(bytes));
}

function derEncodeUtf8String(str) {
  return derWrap(TAG_UTF8STRING, Buffer.from(str, 'utf-8'));
}

function derEncodeOctetString(buf) {
  return derWrap(TAG_OCTET_STRING, buf);
}

function derWrapContext(tagNum, content) {
  return derWrap(TAG_CTX(tagNum), content);
}

function derDecodeLength(buf, offset) {
  if (offset >= buf.length) throw new Error('Truncated DER length');
  const first = buf[offset];
  if (first < 0x80) {
    return { length: first, bytesRead: 1 };
  }
  const numBytes = first & 0x7f;
  if (!numBytes || numBytes > 4 || offset + numBytes >= buf.length) throw new Error('Invalid DER length');
  let length = 0;
  for (let i = 0; i < numBytes; i++) {
    length = length * 256 + buf[offset + 1 + i];
  }
  return { length, bytesRead: 1 + numBytes };
}

function derDecodeTLV(buf, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset + 2 > buf.length) throw new Error('Truncated DER field');
  const tag = buf[offset];
  const { length, bytesRead } = derDecodeLength(buf, offset + 1);
  const headerLen = 1 + bytesRead;
  if (length > buf.length - offset - headerLen) throw new Error('Truncated DER value');
  const value = buf.slice(offset + headerLen, offset + headerLen + length);
  return { tag, value, totalLength: headerLen + length };
}

function derDecodeInteger(buf) {
  let val = 0;
  for (let i = 0; i < buf.length; i++) {
    val = (val << 8) | buf[i];
  }
  return val;
}

function derDecodeChildren(buf) {
  const children = [];
  let offset = 0;
  while (offset < buf.length) {
    const tlv = derDecodeTLV(buf, offset);
    children.push(tlv);
    offset += tlv.totalLength;
  }
  return children;
}

// ────────────────────────────────────────────────────
// RDCleanPath PDU Parsing & Encoding
// ────────────────────────────────────────────────────

function parseRDCleanPathRequest(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

  const outer = derDecodeTLV(buf, 0);
  if (outer.tag !== TAG_SEQUENCE) {
    throw new Error(`Expected SEQUENCE (0x30), got 0x${outer.tag.toString(16)}`);
  }

  if (outer.totalLength !== buf.length) throw new Error('Unexpected trailing RDCleanPath data');
  const children = derDecodeChildren(outer.value);

  let version = null;
  let destination = null;
  let proxyAuth = null;
  let x224ConnectionRequest = null;
  let preconnectionBlob = null;

  const seen = new Set();
  for (const child of children) {
    if ((child.tag & 0xe0) !== 0xa0) throw new Error('Expected explicit RDCleanPath field');
    const ctxTag = child.tag & 0x1f;

    if (seen.has(ctxTag)) throw new Error('Duplicate RDCleanPath field');
    seen.add(ctxTag);
    const expectedTag = { 0: TAG_INTEGER, 2: TAG_UTF8STRING, 6: TAG_OCTET_STRING }[ctxTag];
    if (expectedTag !== undefined) {
      const inner = derDecodeTLV(child.value, 0);
      if (inner.tag !== expectedTag || inner.totalLength !== child.value.length) throw new Error('Invalid RDCleanPath field type');
    }
    switch (ctxTag) {
      case 0: { // version
        const intTlv = derDecodeTLV(child.value, 0);
        version = derDecodeInteger(intTlv.value);
        break;
      }
      case 2: { // destination
        const strTlv = derDecodeTLV(child.value, 0);
        destination = strTlv.value.toString('utf-8');
        break;
      }
      case 3: { // proxy_auth
        const strTlv = derDecodeTLV(child.value, 0);
        proxyAuth = strTlv.value.toString('utf-8');
        break;
      }
      case 5: { // preconnection_blob
        const strTlv = derDecodeTLV(child.value, 0);
        preconnectionBlob = strTlv.value.toString('utf-8');
        break;
      }
      case 6: { // x224_connection_pdu
        const octTlv = derDecodeTLV(child.value, 0);
        x224ConnectionRequest = octTlv.value;
        break;
      }
    }
  }

  if (version !== VERSION_1) {
    throw new Error(`Unsupported RDCleanPath version: ${version} (expected ${VERSION_1})`);
  }
  if (!destination) {
    throw new Error('Missing destination in RDCleanPath request');
  }
  if (!x224ConnectionRequest || !x224ConnectionRequest.length) {
    throw new Error('Missing x224_connection_pdu in RDCleanPath request');
  }

  if (x224ConnectionRequest.length < 4 || x224ConnectionRequest[0] !== 3 || x224ConnectionRequest.readUInt16BE(2) !== x224ConnectionRequest.length) throw new Error('Invalid X.224 request');
  return { destination, proxyAuth, x224ConnectionRequest, preconnectionBlob };
}

function buildRDCleanPathResponse(serverAddr, x224Response, certChain) {
  const parts = [];

  // [0] version
  parts.push(derWrapContext(0, derEncodeInteger(VERSION_1)));

  // [6] x224_connection_pdu
  parts.push(derWrapContext(6, derEncodeOctetString(x224Response)));

  // [7] server_cert_chain
  const certOctets = certChain.map((cert) => derEncodeOctetString(cert));
  const certSeq = derWrap(TAG_SEQUENCE, Buffer.concat(certOctets));
  parts.push(derWrapContext(7, certSeq));

  // [9] server_addr
  parts.push(derWrapContext(9, derEncodeUtf8String(serverAddr)));

  return derWrap(TAG_SEQUENCE, Buffer.concat(parts));
}

function buildRDCleanPathError(errorCode, httpStatusCode) {
  const errParts = [];

  errParts.push(derWrapContext(0, derEncodeInteger(errorCode)));

  if (httpStatusCode != null) {
    errParts.push(derWrapContext(1, derEncodeInteger(httpStatusCode)));
  }

  const errSeq = derWrap(TAG_SEQUENCE, Buffer.concat(errParts));

  const parts = [];
  parts.push(derWrapContext(0, derEncodeInteger(VERSION_1)));
  parts.push(derWrapContext(1, errSeq));

  return derWrap(TAG_SEQUENCE, Buffer.concat(parts));
}

function parseDestination(destination) {
  if (destination.startsWith('[')) {
    const bracketEnd = destination.indexOf(']');
    if (bracketEnd === -1) throw new Error(`Invalid IPv6 destination: ${destination}`);
    const host = destination.slice(1, bracketEnd);
    const rest = destination.slice(bracketEnd + 1);
    const port = rest.startsWith(':') ? parseInt(rest.slice(1), 10) : 3389;
    return { host, port };
  }

  const lastColon = destination.lastIndexOf(':');
  if (lastColon === -1) {
    return { host: destination, port: 3389 };
  }
  const host = destination.slice(0, lastColon);
  const port = parseInt(destination.slice(lastColon + 1), 10);
  return { host, port: isNaN(port) ? 3389 : port };
}

function performRDPHandshake(host, port, x224Request, serverId) {
  return new Promise((resolve, reject) => {
    const logPrefix = `[RDP:${host}:${port}]`;

    const tcpSocket = net.createConnection({ host, port }, () => {
      console.log(`${logPrefix} TCP connection established`);

      tcpSocket.write(x224Request, () => {
        console.log(`${logPrefix} Sent X.224 Connection Request (${x224Request.length} bytes)`);
      });
    });

    tcpSocket.setNoDelay(true);

    let x224Response = null;
    let bytesNeeded = 0;

    const onData = (chunk) => {
      if (!x224Response) {
        x224Response = Buffer.from(chunk);
      } else {
        x224Response = Buffer.concat([x224Response, chunk]);
      }

      if (x224Response.length >= 4 && bytesNeeded === 0) {
        if (x224Response[0] !== 3 || x224Response[1] !== 0 || x224Response.readUInt16BE(2) < 4) { tcpSocket.destroy(); reject(new Error('Invalid X.224 response')); return; }
        bytesNeeded = (x224Response[2] << 8) | x224Response[3];
      }

      if (bytesNeeded > 0 && x224Response.length >= bytesNeeded) {
        tcpSocket.removeListener('data', onData);
        if (x224Response.length > bytesNeeded) tcpSocket.unshift(x224Response.subarray(bytesNeeded));
        x224Response = x224Response.subarray(0, bytesNeeded);
        console.log(`${logPrefix} Received X.224 Connection Confirm (${x224Response.length} bytes)`);

        const tlsSocket = tls.connect(
          {
            socket: tcpSocket,
            servername: net.isIP(host) ? undefined : host,
            rejectUnauthorized: false
          },
          () => {
            console.log(`${logPrefix} TLS handshake completed`);
            const peerCert = tlsSocket.getPeerCertificate(true);
            try {
              if (!serverId || !peerCert.raw) throw new Error('Missing server identity');
              configManager.trustRemoteIdentity(serverId, 'rdpCertificateFingerprint', crypto.createHash('sha256').update(peerCert.raw).digest('hex'));
            } catch (err) { tlsSocket.destroy(); reject(err); return; }
            const certChain = extractCertChain(peerCert);
            tcpSocket.setTimeout(0);
            console.log(`${logPrefix} Extracted ${certChain.length} certificate(s)`);
            resolve({ x224Response: Buffer.from(x224Response), certChain, tlsSocket });
          }
        );

        tlsSocket.once('error', (err) => {
          tlsSocket.destroy();
          reject(new Error(`TLS handshake failed: ${err.message}`));
        });
      }
    };

    tcpSocket.on('data', onData);

    tcpSocket.once('close', () => reject(new Error('Connection closed during handshake')));
    tcpSocket.once('error', (err) => {
      reject(new Error(`TCP connection failed: ${err.message}`));
    });

    tcpSocket.setTimeout(15000, () => {
      tcpSocket.destroy();
      reject(new Error('Connection timed out'));
    });
  });
}

function extractCertChain(peerCert) {
  const certs = [];
  if (!peerCert || !peerCert.raw) return certs;

  const seen = new Set();
  let current = peerCert;
  while (current && current.raw) {
    const fingerprint = current.fingerprint256 || current.raw.toString('hex');
    if (seen.has(fingerprint)) break;
    seen.add(fingerprint);
    certs.push(Buffer.from(current.raw));

    if (current.issuerCertificate && current.issuerCertificate !== current) {
      current = current.issuerCertificate;
    } else {
      break;
    }
  }
  return certs;
}

function setupRelay(ws, tlsSocket) {
  let wsBytesForwarded = 0;
  let tlsBytesForwarded = 0;
  const logPrefix = '[RDP Relay]';

  tlsSocket.on('data', (data) => {
    tlsBytesForwarded += data.length;
    try {
      if (ws.readyState === 1 /* OPEN */) {
        ws.send(data, { binary: true });
      }
    } catch (err) {
      console.error(`${logPrefix} TLS->WS write error:`, err.message);
    }
  });

  ws.on('message', (data) => {
    wsBytesForwarded += data.length;
    try {
      if (!tlsSocket.destroyed) {
        tlsSocket.write(data);
      }
    } catch (err) {
      console.error(`${logPrefix} WS->TLS write error:`, err.message);
    }
  });

  const cleanup = (source) => {
    console.log(`${logPrefix} ${source} closed — WS->TLS: ${wsBytesForwarded} bytes, TLS->WS: ${tlsBytesForwarded} bytes`);
    if (!tlsSocket.destroyed) tlsSocket.destroy();
    if (ws.readyState === 1) {
      try { ws.close(); } catch (_) {}
    }
  };

  tlsSocket.on('end', () => cleanup('TLS'));
  tlsSocket.on('close', () => cleanup('TLS'));
  tlsSocket.on('error', (err) => {
    console.error(`${logPrefix} TLS error:`, err.message);
    cleanup('TLS (error)');
  });

  ws.on('close', () => cleanup('WebSocket'));
  ws.on('error', (err) => {
    console.error(`${logPrefix} WebSocket error:`, err.message);
    cleanup('WebSocket (error)');
  });
}

function handleRdpConnection(ws, req, server) {
  console.log(`[RDP Proxy] New WebSocket connection for server: ${server.name} (${server.host}:${server.port})`);

  const firstMessageTimer = setTimeout(() => ws.close(1008, 'RDP handshake timed out'), 15000);
  firstMessageTimer.unref();
  ws.once('close', () => clearTimeout(firstMessageTimer));
  ws.once('message', async (data) => {
    clearTimeout(firstMessageTimer);
    try {
      const requestData = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const request = parseRDCleanPathRequest(requestData);

      // 보안: 서버 설정의 host/port를 강제 적용
      const targetHost = server.host;
      const targetPort = server.port || 3389;

      console.log(`[RDP Proxy] RDCleanPath handshake starting to ${targetHost}:${targetPort}`);

      const { x224Response, certChain, tlsSocket } = await performRDPHandshake(
        targetHost,
        targetPort,
        request.x224ConnectionRequest,
        server.id
      );

      const serverAddr = `${targetHost}:${targetPort}`;
      const responsePdu = buildRDCleanPathResponse(serverAddr, x224Response, certChain);

      if (ws.readyState === 1) {
        ws.send(responsePdu);
        console.log(`[RDP Proxy] Handshake complete, starting relay`);
        setupRelay(ws, tlsSocket);
      } else {
        tlsSocket.destroy();
      }
    } catch (err) {
      console.error('[RDP Proxy] Handshake error:', err.message);
      try {
        const errorPdu = buildRDCleanPathError(1, 502);
        if (ws.readyState === 1) {
          ws.send(errorPdu);
        }
      } catch (_) {}
      try { ws.close(1011, 'RDP handshake failed'); } catch (_) {}
    }
  });

  ws.on('error', (err) => {
    console.error('[RDP Proxy] WebSocket error:', err.message);
  });
}

module.exports = {
  handleRdpConnection,
  parseRDCleanPathRequest,
  buildRDCleanPathResponse,
  buildRDCleanPathError,
  parseDestination,
  performRDPHandshake,
  setupRelay
};
