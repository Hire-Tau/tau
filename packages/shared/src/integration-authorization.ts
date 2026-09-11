export type IntegrationAuthorizationStart =
  | { authorizationUrl: string }
  | {
      kind: 'device'
      id: string
      userCode: string
      verificationUri: string
      expiresAt: string
      intervalSeconds: number
    }

export type IntegrationDeviceAuthorizationStatus =
  | { status: 'pending'; retryAfterSeconds: number }
  | { status: 'complete'; returnTo: string }
  | { status: 'failed'; code: string }
