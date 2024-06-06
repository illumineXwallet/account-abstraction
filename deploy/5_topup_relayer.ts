import { HardhatRuntimeEnvironment } from 'hardhat/types'
import { DeployFunction } from 'hardhat-deploy/types'
import { ethers } from 'hardhat'

const topupRelayer: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const provider = ethers.provider
  const signer = provider.getSigner()

  const relayerAddress = '0x6ACf3Cfe652cCDF0A66178c57C6C723F51BDdE6E'

  const targetBalance = 2n * 10n ** 18n
  const currentBalance = (await provider.getBalance(relayerAddress)).toBigInt()
  if (currentBalance < targetBalance / 2n) {
    const a = await signer.sendTransaction({
      to: relayerAddress,
      value: targetBalance - currentBalance
    })
    await a.wait()
    console.log(`  Deposited ${targetBalance - currentBalance} for relayer`)
  }
}

export default topupRelayer