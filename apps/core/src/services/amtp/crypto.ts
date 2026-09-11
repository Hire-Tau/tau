// Pure re-export: the crypto primitives live in amtp-protocol (the amtp-protocol npm package), which
// apps/cli also depends on directly. This file exists only so existing apps/core importers keep
// their local import path.
export { generateInstanceKeyPair, instanceIdFromPublicKeyPem, signEnvelope, verifyEnvelope } from 'amtp-protocol'
