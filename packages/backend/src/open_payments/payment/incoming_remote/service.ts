import {
  AuthenticatedClient,
  IncomingPaymentWithPaymentMethods as OpenPaymentsIncomingPaymentWithPaymentMethods,
  isPendingGrant,
  AccessAction,
  WalletAddress as OpenPaymentsWalletAddress
} from '@interledger/open-payments'
import { Grant } from '../../grant/model'
import { GrantService } from '../../grant/service'
import { BaseService } from '../../../shared/baseService'
import { Amount, serializeAmount } from '../../amount'
import {
  isRemoteIncomingPaymentError,
  RemoteIncomingPaymentError
} from './errors'

interface CreateRemoteIncomingPaymentArgs {
  walletAddressUrl: string
  expiresAt?: Date
  incomingAmount?: Amount
  metadata?: Record<string, unknown>
}

export interface RemoteIncomingPaymentService {
  create(
    args: CreateRemoteIncomingPaymentArgs
  ): Promise<
    OpenPaymentsIncomingPaymentWithPaymentMethods | RemoteIncomingPaymentError
  >
}

interface ServiceDependencies extends BaseService {
  grantService: GrantService
  openPaymentsUrl: string
  openPaymentsClient: AuthenticatedClient
}

export async function createRemoteIncomingPaymentService(
  deps_: ServiceDependencies
): Promise<RemoteIncomingPaymentService> {
  const log = deps_.logger.child({
    service: 'RemoteIncomingPaymentService'
  })
  const deps: ServiceDependencies = {
    ...deps_,
    logger: log
  }

  return {
    create: (args) => create(deps, args)
  }
}

async function create(
  deps: ServiceDependencies,
  args: CreateRemoteIncomingPaymentArgs
): Promise<
  OpenPaymentsIncomingPaymentWithPaymentMethods | RemoteIncomingPaymentError
> {
  const { walletAddressUrl } = args
  const grantOrError = await getGrant(deps, walletAddressUrl, [
    AccessAction.Create,
    AccessAction.ReadAll
  ])

  if (isRemoteIncomingPaymentError(grantOrError)) {
    return grantOrError
  }

  try {
    const url = new URL(walletAddressUrl)
    return await deps.openPaymentsClient.incomingPayment.create(
      {
        url: url.origin,
        accessToken: grantOrError.accessToken
      },
      {
        walletAddress: walletAddressUrl,
        incomingAmount: args.incomingAmount
          ? serializeAmount(args.incomingAmount)
          : undefined,
        expiresAt: args.expiresAt?.toISOString(),
        metadata: args.metadata ?? undefined
      }
    )
  } catch (error) {
    const errorMessage = 'Error creating remote incoming payment'
    deps.logger.error({ error, walletAddressUrl }, errorMessage)
    return RemoteIncomingPaymentError.InvalidRequest
  }
}

async function getGrant(
  deps: ServiceDependencies,
  walletAddressUrl: string,
  accessActions: AccessAction[]
): Promise<Grant | RemoteIncomingPaymentError> {
  let walletAddress: OpenPaymentsWalletAddress

  try {
    walletAddress = await deps.openPaymentsClient.walletAddress.get({
      url: walletAddressUrl
    })
  } catch (error) {
    const errorMessage = 'Could not get wallet address'
    deps.logger.error({ walletAddressUrl, error }, errorMessage)
    return RemoteIncomingPaymentError.UnknownWalletAddress
  }

  const grantOptions = {
    authServer: walletAddress.authServer,
    accessType: 'incoming-payment' as const,
    accessActions
  }

  const existingGrant = await deps.grantService.get(grantOptions)

  if (existingGrant) {
    if (existingGrant.expired) {
      if (!existingGrant.authServer) {
        throw new Error('unknown auth server')
      }
      try {
        const rotatedToken = await deps.openPaymentsClient.token.rotate({
          url: existingGrant.getManagementUrl(existingGrant.authServer.url),
          accessToken: existingGrant.accessToken
        })
        return deps.grantService.update(existingGrant, {
          accessToken: rotatedToken.access_token.value,
          managementUrl: rotatedToken.access_token.manage,
          expiresIn: rotatedToken.access_token.expires_in
        })
      } catch (err) {
        deps.logger.error({ err, grantOptions }, 'Grant token rotation failed.')
        throw err
      }
    }
    return existingGrant
  }

  const grant = await deps.openPaymentsClient.grant.request(
    { url: walletAddress.authServer },
    {
      access_token: {
        access: [
          {
            type: grantOptions.accessType,
            actions: grantOptions.accessActions
          }
        ]
      },
      interact: {
        start: ['redirect']
      }
    }
  )

  if (!isPendingGrant(grant)) {
    return deps.grantService.create({
      ...grantOptions,
      accessToken: grant.access_token.value,
      managementUrl: grant.access_token.manage,
      expiresIn: grant.access_token.expires_in
    })
  }

  const errorMessage = 'Grant is pending/requires interaction'
  deps.logger.warn({ grantOptions }, errorMessage)
  return RemoteIncomingPaymentError.InvalidGrant
}
