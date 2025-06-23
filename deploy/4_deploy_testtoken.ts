import type { HardhatRuntimeEnvironment } from 'hardhat/types'
import type { DeployFunction } from 'hardhat-deploy/types'
import { ethers } from 'hardhat'
import assert from 'node:assert'
import { DECIMALS, WNATIVE } from './const'
import registeredTokens from '../tokens.json'

const deploySimpleAccountFactory: DeployFunction = async (hre: HardhatRuntimeEnvironment) => {
  const provider = ethers.provider
  const from = await provider.getSigner().getAddress()

  ////////////////////////////////

  const chainId = hre.network.config.chainId
  assert(typeof chainId === 'number', 'ChainId must be a number')
  const wNativeAddress = WNATIVE[chainId]

  if (wNativeAddress?.length === 0) {
    console.log('  WNATIVE not set. Skipping oracle configuration')
  }

  const paymaster = await ethers.getContractAt('LuminexTokenPaymaster', (await hre.deployments.get('LuminexTokenPaymaster')).address)

  // pROSE shortcircut
  const oracleResult = await hre.deployments.deploy(
    'LuminexOracleConst', {
    from,
    args: [from, wNativeAddress, wNativeAddress],
    gasLimit: 6e6,
    log: true,
    deterministicDeployment: true
  })

  if (oracleResult.newlyDeployed) console.log(`    Oracle pROSE deployed ${oracleResult.address}`)

  const oracle = await ethers.getContractAt('LuminexOracleConst', oracleResult.address)

  const val = await Promise.all([oracle.token0Value(), oracle.token1Value()])
  if (!val[0].eq(1) || !val[1].eq(1)) {
    const tx = await oracle.setValues(1, 1)
    await tx.wait()
    console.log(`    Oracle pROSE (${oracleResult.address}) price set [1, 1]`)
  }

  if (await paymaster.oracles(wNativeAddress) === oracleResult.address) {
    await (await paymaster.setOracle(wNativeAddress, oracleResult.address)).wait()
    console.log(`    Oracle pROSE (${oracleResult.address}) registered`)
  }

  const humanPriceProportions = new Map<typeof registeredTokens['tokens'][number]['ixSlug'], string>([
    ['BNB', '5388'],
    ['USDT@bsc', '9.173699832'],
    ['ETH', '100358.70'],
    ['USDC@eth', '45.51'],
    ['DAI@eth', '45.51'],
    ['USDT@eth', '45.51'],
    ['ETH@arbitrum', '36812.04274074493'],
    ['POL', '6.505047202855522'],
    ['BTC', '878354.127267101'],
    ['WBTC@eth', '878354.127267101'],
    ['IX@eth', '0.25']
  ])

  const txs = []
  for (const token of registeredTokens.tokens) {
    const rawPrice = humanPriceProportions.get(token.ixSlug)
    if (!rawPrice) {
      console.log(`No price found for ${token.ixSlug}`)
      continue
    }

    const oracleResult = await hre.deployments.deploy(
      'LuminexOracleConst', {
      from,
      args: [from, wNativeAddress, token.address],
      gasLimit: 6e6,
      log: true,
      deterministicDeployment: true
    })

    const oracle = await ethers.getContractAt('LuminexOracleConst', oracleResult.address)


    const [significatn, base] = prop(rawPrice)
    let nativeReceived = significatn * 10n ** BigInt(DECIMALS)
    let tokenCost = base * 10n ** BigInt(token.decimals)
    const denominator = gcd(nativeReceived, tokenCost)
    nativeReceived/=denominator
    tokenCost/=denominator

    const [curReceived, curCost] = await Promise.all([oracle.token0Value(), oracle.token1Value()])
    if (nativeReceived !== curReceived.toBigInt() || tokenCost !== curCost.toBigInt()) {
      const tx = await oracle.setValues(nativeReceived, tokenCost)
      txs.push(tx.wait().then(() => {
        console.log(`  Oracle ${token.ixSlug} (${oracle.address}) price set [${nativeReceived}, ${tokenCost}]`)
      }).catch(e => {
        console.log({ tokenAddress: token.address, oracleAddress: oracleResult.address, price: [nativeReceived, tokenCost] })
        throw e
      }))
    }

    if (await paymaster.oracles(token.address) === oracleResult.address) {
      continue
    }

    const tx = (await paymaster.setOracle(token.address, oracleResult.address))
    txs.push(tx.wait().catch(e => {
      console.log({ tokenAddress: token.address, oracleAddress: oracleResult.address })
      throw e
    }))
  }
  for (const result of await Promise.allSettled(txs)) {
    if (result.status === 'rejected') {
      console.error(result.reason)
    }
  }
}

export default deploySimpleAccountFactory

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  // Euclidean algorithm
  while (b !== 0n) {
    const temp = b;
    b = a % b;
    a = temp;
  }

  return a;
}


function prop(input: string): [mantise: bigint, base: bigint] {
  const regexp = /^(\d+)(?:\.(\d+))?$/
  // biome-ignore lint/style/noNonNullAssertion: we know what we're doing
  const match = input.match(regexp)!
  const mantise = BigInt(match[1]+(match[2]??''))
  const base = 10n ** BigInt(match[2]?.length ?? 0)
  return [mantise, base]
}