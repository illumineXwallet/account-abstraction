import type { HardhatRuntimeEnvironment } from 'hardhat/types'
import type { DeployFunction } from 'hardhat-deploy/types'
import { ethers } from 'hardhat'
import assert from 'node:assert'
import { WNATIVE } from './const'
import type { LuminexAccountFactory, LuminexTokenPaymaster } from '../typechain'
import registeredTokens from '../tokens.json'

const deploySimpleAccountFactory: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const provider = ethers.provider
  const signer = provider.getSigner()
  const from = await signer.getAddress()

  const chainId = hre.network.config.chainId
  assert(typeof chainId === 'number', 'ChainId must be a number')

  const factoryDeployed = await hre.deployments.get('LuminexAccountFactory')

  const entrypointDeployment = await hre.deployments.get('EntryPoint')
  const paymasterDeployed = await hre.deployments.deploy(
    'LuminexTokenPaymaster', {
      from,
      args: [entrypointDeployment.address, from, WNATIVE[chainId], factoryDeployed.address],
      gasLimit: 6e6,
      log: true,
      deterministicDeployment: true
    })

  const factory = await hre.ethers.getContractAt('LuminexAccountFactory', factoryDeployed.address)
  const paymaster = await hre.ethers.getContractAt('LuminexTokenPaymaster', paymasterDeployed.address)

  const BALANCE_VIEWER = await factory.BALANCE_VIEWER()
  if (!await factory.hasRole(BALANCE_VIEWER, paymasterDeployed.address)) {
    const tx = await factory.grantRole(BALANCE_VIEWER, paymasterDeployed.address)
    await tx.wait()
    console.log(`  Granted LuminexAccountFactory.BALANCE_VIEWER to ${paymasterDeployed.address}`)
  }

  await approveCalls(factory, paymaster)

  const entryPoint = await ethers.getContractAt('EntryPoint', entrypointDeployment.address)

  const targetDeposit = 150n * 10n ** 18n
  const currentDeposit = (await entryPoint.balanceOf(paymasterDeployed.address)).toBigInt()
  if (currentDeposit < targetDeposit / 2n) {
    const a = await entryPoint.depositTo(paymasterDeployed.address, {
      value: targetDeposit - currentDeposit
    })
    await a.wait()
    console.log(`  Deposited ${targetDeposit - currentDeposit} to EP for paymaster`)
  }

  const targetBalance = 1n * 10n ** 18n
  const currentBalance = (await provider.getBalance(paymasterDeployed.address)).toBigInt()
  if (currentBalance < targetBalance / 2n) {
    const value = targetBalance - currentBalance
    console.log({ value })
    const a = await signer.sendTransaction({
      to: paymasterDeployed.address,
      value: value
    })
    await a.wait()
    console.log(`  Sent ${targetBalance - currentBalance} NATIVE to paymaster for native trading`)
  }
}
deploySimpleAccountFactory.skip = async (env) => {
  const chainId = env.network.config.chainId
  return WNATIVE[chainId ?? -1] === undefined
}

export default deploySimpleAccountFactory

async function approveCalls (factory: LuminexAccountFactory, paymaster: LuminexTokenPaymaster) {
  const selector = (abiString: string): string => {
    return ethers.utils.solidityKeccak256(['string'], [abiString]).slice(0, 10)
  }

  const foreignTargetAllowedCalls = [
    [
      'FragmentedReserves',
      '0x52fC5d04fa27389AE6a4c395Afd5ca80F32362Ba',
      [
        selector('exchange(address,address,uint256,uint256,address)')
      ]
    ],
    [
      'ReferralReporter',
      '0x08C0d4F1D48791d9dC30eB13757594AB5BDfe663',
      [
        selector('reportSwapVolume(bytes32,uint256)')
      ]
    ],
    [
      'DepositVault',
      '0xfb88fe57D84636EC1eAfF8d8B9Ad0E771f7e3456',
      [
        selector('deposit(bytes32,address,uint256)')
      ]
    ],
    [
      'SapphireEndpoint',
      '0xdC811ae9D2B36002304F6f0e471b1dEA87Ca8bb5',
      [
        selector('proxyPass(address,uint256,bytes)')
      ]
    ],
    [
      'ProxyGuard',
      '0x5d27cEc109Ca45D2ABe8f759b61AcBdd4cC80679',
      [
        selector('proxyPass(address,uint256,bytes)')
      ]
    ],
    [
      'XeBTCVault',
      '0xE24A32b3D0FBbf887A5957D83Ad32AdA8A043126',
      [
        selector('withdraw(bytes,uint64,uint64,bytes32)')
      ]
    ]
  ] as Array<[string, string, string[]]>

  const getSelectorsWhitelist = (): Array<[string, string, string[]]> => {
    const paymasterTargetAllowedCalls = [
      'Paymaster',
      paymaster.address,
      [
        selector('buyNativeForToken(address,uint256,uint256,address)'),
        selector('tokensRequiredForNative(address,uint256)'),
        selector('debt(address,address)')
      ]
    ] as [string, string, string[]]

    const tokensAllowedCalls =
      registeredTokens.tokens
        .map((token) => ([
          token.ixSlug,
          token.address,
          [
            selector('transfer(address,uint256)'),
            selector('approve(address,uint256)'),
            selector('transferFrom(address,address,uint256)'),
            selector('balanceOf(address)'),
            selector('unwrap(uint256,address)')
          ]
        ] as [string, string, string[]]))

    return [
      ...foreignTargetAllowedCalls,
      paymasterTargetAllowedCalls,
      ...tokensAllowedCalls
    ]
  }

  const allowedCalls = getSelectorsWhitelist()
  for (const [name, target, selectors] of allowedCalls) {
    let allRegistered = true
    for (let i = 0; i < selectors.length && allRegistered; i++) {
      const selector = selectors[i]
      allRegistered = await factory.callStatic.isCallAllowed(target, selector)
    }

    if (allRegistered) continue

    const tx = await factory.allowCalls(target, selectors)
    await tx.wait()
    console.log('  Allowed calls', {
      name, target, selectors
    })
  }
}
