import {
  L1Network,
  L1ToL2MessageGasEstimator,
  L1ToL2MessageStatus,
  L1TransactionReceipt,
  L2Network,
  L2TransactionReceipt,
} from '@arbitrum/sdk'
import { getBaseFee } from '@arbitrum/sdk/dist/lib/utils/lib'
import { JsonRpcProvider } from '@ethersproject/providers'
import { expect } from 'chai'
import { setupTokenBridgeInLocalEnv } from '../scripts/local-deployment/localDeploymentLib'
import {
  BridgedUsdcCustomToken__factory,
  ERC20,
  ERC20__factory,
  IERC20Bridge__factory,
  IInbox__factory,
  IOwnable__factory,
  L1FeeTokenUSDCCustomGateway__factory,
  L1GatewayRouter__factory,
  L1OrbitCustomGateway__factory,
  L1OrbitERC20Gateway__factory,
  L1OrbitGatewayRouter__factory,
  L1USDCCustomGateway__factory,
  L2CustomGateway__factory,
  L2GatewayRouter__factory,
  L2USDCCustomGateway__factory,
  MockL1Usdc__factory,
  ProxyAdmin__factory,
  TestArbCustomToken__factory,
  TestCustomTokenL1__factory,
  TestERC20,
  TestERC20__factory,
  TestOrbitCustomTokenL1__factory,
  TransparentUpgradeableProxy__factory,
  UpgradeExecutor__factory,
} from '../build/types'
import { defaultAbiCoder } from 'ethers/lib/utils'
import { BigNumber, Wallet, ethers } from 'ethers'
import { exit } from 'process'

const config = {
  parentUrl: 'http://localhost:8547',
  childUrl: 'http://localhost:3347',
}

const LOCALHOST_L3_OWNER_KEY =
  '0xecdf21cb41c65afb51f91df408b7656e2c8739a5877f2814add0afd780cc210e'

let parentProvider: JsonRpcProvider
let childProvider: JsonRpcProvider

let deployerL1Wallet: Wallet
let deployerL2Wallet: Wallet

let userL1Wallet: Wallet
let userL2Wallet: Wallet

let _l1Network: L1Network
let _l2Network: L2Network

let token: TestERC20
let l2Token: ERC20
let nativeToken: ERC20 | undefined

describe('orbitTokenBridge', () => {
  // configure orbit token bridge
  before(async function () {
    parentProvider = new ethers.providers.JsonRpcProvider(config.parentUrl)
    childProvider = new ethers.providers.JsonRpcProvider(config.childUrl)

    const testDevKey =
      '0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659'
    const testDevL1Wallet = new ethers.Wallet(testDevKey, parentProvider)
    const testDevL2Wallet = new ethers.Wallet(testDevKey, childProvider)

    const deployerKey = ethers.utils.sha256(
      ethers.utils.toUtf8Bytes('user_token_bridge_deployer')
    )
    deployerL1Wallet = new ethers.Wallet(deployerKey, parentProvider)
    deployerL2Wallet = new ethers.Wallet(deployerKey, childProvider)
    await (
      await testDevL1Wallet.sendTransaction({
        to: deployerL1Wallet.address,
        value: ethers.utils.parseEther('20.0'),
      })
    ).wait()
    await (
      await testDevL2Wallet.sendTransaction({
        to: deployerL2Wallet.address,
        value: ethers.utils.parseEther('20.0'),
      })
    ).wait()

    const { l1Network, l2Network } = await setupTokenBridgeInLocalEnv()

    _l1Network = l1Network
    _l2Network = l2Network

    // create user wallets and fund it
    const userKey = ethers.utils.sha256(ethers.utils.toUtf8Bytes('user_wallet'))
    userL1Wallet = new ethers.Wallet(userKey, parentProvider)
    userL2Wallet = new ethers.Wallet(userKey, childProvider)
    await (
      await deployerL1Wallet.sendTransaction({
        to: userL1Wallet.address,
        value: ethers.utils.parseEther('10.0'),
      })
    ).wait()
    await (
      await deployerL2Wallet.sendTransaction({
        to: userL2Wallet.address,
        value: ethers.utils.parseEther('10.0'),
      })
    ).wait()

    const nativeTokenAddress = await getFeeToken(
      l2Network.ethBridge.inbox,
      parentProvider
    )
    nativeToken =
      nativeTokenAddress === ethers.constants.AddressZero
        ? undefined
        : ERC20__factory.connect(nativeTokenAddress, userL1Wallet)

    if (nativeToken) {
      const supply = await nativeToken.balanceOf(deployerL1Wallet.address)
      await (
        await nativeToken
          .connect(deployerL1Wallet)
          .transfer(userL1Wallet.address, supply.div(10))
      ).wait()
    }
  })

  it('should have deployed token bridge contracts', async function () {
    // get router as entry point
    const l1Router = L1OrbitGatewayRouter__factory.connect(
      _l2Network.tokenBridge.l1GatewayRouter,
      parentProvider
    )

    expect((await l1Router.defaultGateway()).toLowerCase()).to.be.eq(
      _l2Network.tokenBridge.l1ERC20Gateway.toLowerCase()
    )
  })

  it('can deposit token via default gateway', async function () {
    // fund user to be able to pay retryable fees
    if (nativeToken) {
      await (
        await nativeToken
          .connect(deployerL1Wallet)
          .transfer(userL1Wallet.address, ethers.utils.parseEther('1000'))
      ).wait()
      nativeToken.connect(userL1Wallet)
    }

    // create token to be bridged
    const tokenFactory = await new TestERC20__factory(userL1Wallet).deploy()
    token = await tokenFactory.deployed()
    await (await token.mint()).wait()

    // snapshot state before
    const userTokenBalanceBefore = await token.balanceOf(userL1Wallet.address)

    const gatewayTokenBalanceBefore = await token.balanceOf(
      _l2Network.tokenBridge.l1ERC20Gateway
    )
    const userNativeTokenBalanceBefore = nativeToken
      ? await nativeToken.balanceOf(userL1Wallet.address)
      : await parentProvider.getBalance(userL1Wallet.address)
    const bridgeNativeTokenBalanceBefore = nativeToken
      ? await nativeToken.balanceOf(_l2Network.ethBridge.bridge)
      : await parentProvider.getBalance(_l2Network.ethBridge.bridge)

    // approve token
    const depositAmount = 350
    await (
      await token.approve(_l2Network.tokenBridge.l1ERC20Gateway, depositAmount)
    ).wait()

    // calculate retryable params
    const maxSubmissionCost = nativeToken
      ? BigNumber.from(0)
      : BigNumber.from(584000000000)
    const callhook = '0x'

    const gateway = L1OrbitERC20Gateway__factory.connect(
      _l2Network.tokenBridge.l1ERC20Gateway,
      userL1Wallet
    )
    const outboundCalldata = await gateway.getOutboundCalldata(
      token.address,
      userL1Wallet.address,
      userL2Wallet.address,
      depositAmount,
      callhook
    )

    const l1ToL2MessageGasEstimate = new L1ToL2MessageGasEstimator(
      childProvider
    )
    const retryableParams = await l1ToL2MessageGasEstimate.estimateAll(
      {
        from: userL1Wallet.address,
        to: userL2Wallet.address,
        l2CallValue: BigNumber.from(0),
        excessFeeRefundAddress: userL1Wallet.address,
        callValueRefundAddress: userL1Wallet.address,
        data: outboundCalldata,
      },
      await getBaseFee(parentProvider),
      parentProvider
    )

    const gasLimit = retryableParams.gasLimit.mul(60)
    const maxFeePerGas = retryableParams.maxFeePerGas
    const tokenTotalFeeAmount = gasLimit.mul(maxFeePerGas).mul(2)

    // approve fee amount
    if (nativeToken) {
      await (
        await nativeToken.approve(
          _l2Network.tokenBridge.l1ERC20Gateway,
          tokenTotalFeeAmount
        )
      ).wait()
    }

    // bridge it
    const userEncodedData = nativeToken
      ? defaultAbiCoder.encode(
          ['uint256', 'bytes', 'uint256'],
          [maxSubmissionCost, callhook, tokenTotalFeeAmount]
        )
      : defaultAbiCoder.encode(
          ['uint256', 'bytes'],
          [maxSubmissionCost, callhook]
        )

    const router = nativeToken
      ? L1OrbitGatewayRouter__factory.connect(
          _l2Network.tokenBridge.l1GatewayRouter,
          userL1Wallet
        )
      : L1GatewayRouter__factory.connect(
          _l2Network.tokenBridge.l1GatewayRouter,
          userL1Wallet
        )

    const depositTx = await router.outboundTransferCustomRefund(
      token.address,
      userL1Wallet.address,
      userL2Wallet.address,
      depositAmount,
      gasLimit,
      maxFeePerGas,
      userEncodedData,
      { value: nativeToken ? BigNumber.from(0) : tokenTotalFeeAmount }
    )

    // wait for L2 msg to be executed
    await waitOnL2Msg(depositTx)

    ///// checks

    const l2TokenAddress = await router.calculateL2TokenAddress(token.address)
    l2Token = ERC20__factory.connect(l2TokenAddress, childProvider)
    expect(await l2Token.balanceOf(userL2Wallet.address)).to.be.eq(
      depositAmount
    )

    const userTokenBalanceAfter = await token.balanceOf(userL1Wallet.address)
    expect(userTokenBalanceBefore.sub(userTokenBalanceAfter)).to.be.eq(
      depositAmount
    )

    const gatewayTokenBalanceAfter = await token.balanceOf(
      _l2Network.tokenBridge.l1ERC20Gateway
    )
    expect(gatewayTokenBalanceAfter.sub(gatewayTokenBalanceBefore)).to.be.eq(
      depositAmount
    )

    const userNativeTokenBalanceAfter = nativeToken
      ? await nativeToken.balanceOf(userL1Wallet.address)
      : await parentProvider.getBalance(userL1Wallet.address)
    if (nativeToken) {
      expect(
        userNativeTokenBalanceBefore.sub(userNativeTokenBalanceAfter)
      ).to.be.eq(tokenTotalFeeAmount)
    } else {
      expect(
        userNativeTokenBalanceBefore.sub(userNativeTokenBalanceAfter)
      ).to.be.gte(tokenTotalFeeAmount.toNumber())
    }

    const bridgeNativeTokenBalanceAfter = nativeToken
      ? await nativeToken.balanceOf(_l2Network.ethBridge.bridge)
      : await parentProvider.getBalance(_l2Network.ethBridge.bridge)
    expect(
      bridgeNativeTokenBalanceAfter.sub(bridgeNativeTokenBalanceBefore)
    ).to.be.eq(tokenTotalFeeAmount)
  })

  xit('can withdraw token via default gateway', async function () {
    // fund userL2Wallet so it can pay for L2 withdraw TX
    await depositNativeToL2()

    // snapshot state before
    const userL1TokenBalanceBefore = await token.balanceOf(userL1Wallet.address)
    const userL2TokenBalanceBefore = await l2Token.balanceOf(
      userL2Wallet.address
    )
    const l1GatewayTokenBalanceBefore = await token.balanceOf(
      _l2Network.tokenBridge.l1ERC20Gateway
    )
    const l2TokenSupplyBefore = await l2Token.totalSupply()

    // start withdrawal
    const withdrawalAmount = 250
    const l2Router = L2GatewayRouter__factory.connect(
      _l2Network.tokenBridge.l2GatewayRouter,
      userL2Wallet
    )
    const withdrawTx = await l2Router[
      'outboundTransfer(address,address,uint256,bytes)'
    ](token.address, userL1Wallet.address, withdrawalAmount, '0x')
    const withdrawReceipt = await withdrawTx.wait()
    const l2Receipt = new L2TransactionReceipt(withdrawReceipt)

    // wait until dispute period passes and withdrawal is ready for execution
    await sleep(5 * 1000)

    const messages = await l2Receipt.getL2ToL1Messages(userL1Wallet)
    const l2ToL1Msg = messages[0]
    const timeToWaitMs = 1000
    await l2ToL1Msg.waitUntilReadyToExecute(childProvider, timeToWaitMs)

    // execute on L1
    await (await l2ToL1Msg.execute(childProvider)).wait()

    //// checks
    const userL1TokenBalanceAfter = await token.balanceOf(userL1Wallet.address)
    expect(userL1TokenBalanceAfter.sub(userL1TokenBalanceBefore)).to.be.eq(
      withdrawalAmount
    )

    const userL2TokenBalanceAfter = await l2Token.balanceOf(
      userL2Wallet.address
    )
    expect(userL2TokenBalanceBefore.sub(userL2TokenBalanceAfter)).to.be.eq(
      withdrawalAmount
    )

    const l1GatewayTokenBalanceAfter = await token.balanceOf(
      _l2Network.tokenBridge.l1ERC20Gateway
    )
    expect(
      l1GatewayTokenBalanceBefore.sub(l1GatewayTokenBalanceAfter)
    ).to.be.eq(withdrawalAmount)

    const l2TokenSupplyAfter = await l2Token.totalSupply()
    expect(l2TokenSupplyBefore.sub(l2TokenSupplyAfter)).to.be.eq(
      withdrawalAmount
    )
  })

  it('can deposit token via custom gateway', async function () {
    // fund user to be able to pay retryable fees
    if (nativeToken) {
      await (
        await nativeToken
          .connect(deployerL1Wallet)
          .transfer(userL1Wallet.address, ethers.utils.parseEther('1000'))
      ).wait()
    }

    // create L1 custom token
    const customL1TokenFactory = nativeToken
      ? await new TestOrbitCustomTokenL1__factory(deployerL1Wallet).deploy(
          _l2Network.tokenBridge.l1CustomGateway,
          _l2Network.tokenBridge.l1GatewayRouter
        )
      : await new TestCustomTokenL1__factory(deployerL1Wallet).deploy(
          _l2Network.tokenBridge.l1CustomGateway,
          _l2Network.tokenBridge.l1GatewayRouter
        )
    const customL1Token = await customL1TokenFactory.deployed()
    await (await customL1Token.connect(userL1Wallet).mint()).wait()

    // create L2 custom token
    if (nativeToken) {
      await depositNativeToL2()
    }
    const customL2TokenFactory = await new TestArbCustomToken__factory(
      deployerL2Wallet
    ).deploy(_l2Network.tokenBridge.l2CustomGateway, customL1Token.address)
    const customL2Token = await customL2TokenFactory.deployed()

    // prepare custom gateway registration params
    const router = nativeToken
      ? L1OrbitGatewayRouter__factory.connect(
          _l2Network.tokenBridge.l1GatewayRouter,
          userL1Wallet
        )
      : L1GatewayRouter__factory.connect(
          _l2Network.tokenBridge.l1GatewayRouter,
          userL1Wallet
        )
    const l1ToL2MessageGasEstimate = new L1ToL2MessageGasEstimator(
      childProvider
    )

    const routerData =
      L2GatewayRouter__factory.createInterface().encodeFunctionData(
        'setGateway',
        [[customL1Token.address], [_l2Network.tokenBridge.l2CustomGateway]]
      )
    const routerRetryableParams = await l1ToL2MessageGasEstimate.estimateAll(
      {
        from: _l2Network.tokenBridge.l1GatewayRouter,
        to: _l2Network.tokenBridge.l2GatewayRouter,
        l2CallValue: BigNumber.from(0),
        excessFeeRefundAddress: userL1Wallet.address,
        callValueRefundAddress: userL1Wallet.address,
        data: routerData,
      },
      await getBaseFee(parentProvider),
      parentProvider
    )

    const gatewayData =
      L2CustomGateway__factory.createInterface().encodeFunctionData(
        'registerTokenFromL1',
        [[customL1Token.address], [customL2Token.address]]
      )
    const gwRetryableParams = await l1ToL2MessageGasEstimate.estimateAll(
      {
        from: _l2Network.tokenBridge.l1CustomGateway,
        to: _l2Network.tokenBridge.l2CustomGateway,
        l2CallValue: BigNumber.from(0),
        excessFeeRefundAddress: userL1Wallet.address,
        callValueRefundAddress: userL1Wallet.address,
        data: gatewayData,
      },
      await getBaseFee(parentProvider),
      parentProvider
    )

    // approve fee amount
    const valueForGateway = gwRetryableParams.deposit.mul(BigNumber.from(2))
    const valueForRouter = routerRetryableParams.deposit.mul(BigNumber.from(2))
    if (nativeToken) {
      await (
        await nativeToken.approve(
          customL1Token.address,
          valueForGateway.add(valueForRouter)
        )
      ).wait()
    }

    // do the custom gateway registration
    const receipt = await (
      await customL1Token
        .connect(userL1Wallet)
        .registerTokenOnL2(
          customL2Token.address,
          gwRetryableParams.maxSubmissionCost,
          routerRetryableParams.maxSubmissionCost,
          gwRetryableParams.gasLimit.mul(2),
          routerRetryableParams.gasLimit.mul(2),
          BigNumber.from(100000000),
          valueForGateway,
          valueForRouter,
          userL1Wallet.address,
          {
            value: nativeToken
              ? BigNumber.from(0)
              : valueForGateway.add(valueForRouter),
          }
        )
    ).wait()

    /// wait for execution of both tickets
    const l1TxReceipt = new L1TransactionReceipt(receipt)
    const messages = await l1TxReceipt.getL1ToL2Messages(childProvider)
    const messageResults = await Promise.all(
      messages.map(message => message.waitForStatus())
    )
    if (
      messageResults[0].status !== L1ToL2MessageStatus.REDEEMED ||
      messageResults[1].status !== L1ToL2MessageStatus.REDEEMED
    ) {
      console.log(
        `Retryable ticket (ID ${messages[0].retryableCreationId}) status: ${
          L1ToL2MessageStatus[messageResults[0].status]
        }`
      )
      console.log(
        `Retryable ticket (ID ${messages[1].retryableCreationId}) status: ${
          L1ToL2MessageStatus[messageResults[1].status]
        }`
      )
      exit()
    }

    // snapshot state before
    const userTokenBalanceBefore = await customL1Token.balanceOf(
      userL1Wallet.address
    )
    const gatewayTokenBalanceBefore = await customL1Token.balanceOf(
      _l2Network.tokenBridge.l1CustomGateway
    )
    const userNativeTokenBalanceBefore = nativeToken
      ? await nativeToken.balanceOf(userL1Wallet.address)
      : await parentProvider.getBalance(userL1Wallet.address)
    const bridgeNativeTokenBalanceBefore = nativeToken
      ? await nativeToken.balanceOf(_l2Network.ethBridge.bridge)
      : await parentProvider.getBalance(_l2Network.ethBridge.bridge)

    // approve token
    const depositAmount = 110
    await (
      await customL1Token
        .connect(userL1Wallet)
        .approve(_l2Network.tokenBridge.l1CustomGateway, depositAmount)
    ).wait()

    // calculate retryable params
    const maxSubmissionCost = 0
    const callhook = '0x'

    const gateway = L1OrbitCustomGateway__factory.connect(
      _l2Network.tokenBridge.l1CustomGateway,
      userL1Wallet
    )
    const outboundCalldata = await gateway.getOutboundCalldata(
      customL1Token.address,
      userL1Wallet.address,
      userL2Wallet.address,
      depositAmount,
      callhook
    )

    const retryableParams = await l1ToL2MessageGasEstimate.estimateAll(
      {
        from: userL1Wallet.address,
        to: userL2Wallet.address,
        l2CallValue: BigNumber.from(0),
        excessFeeRefundAddress: userL1Wallet.address,
        callValueRefundAddress: userL1Wallet.address,
        data: outboundCalldata,
      },
      await getBaseFee(parentProvider),
      parentProvider
    )

    const gasLimit = retryableParams.gasLimit.mul(40)
    const maxFeePerGas = retryableParams.maxFeePerGas
    const tokenTotalFeeAmount = gasLimit.mul(maxFeePerGas).mul(2)

    // approve fee amount
    if (nativeToken) {
      await (
        await nativeToken.approve(
          _l2Network.tokenBridge.l1CustomGateway,
          tokenTotalFeeAmount
        )
      ).wait()
    }

    // bridge it
    const userEncodedData = nativeToken
      ? defaultAbiCoder.encode(
          ['uint256', 'bytes', 'uint256'],
          [maxSubmissionCost, callhook, tokenTotalFeeAmount]
        )
      : defaultAbiCoder.encode(
          ['uint256', 'bytes'],
          [BigNumber.from(334400000000), callhook]
        )

    const depositTx = await router.outboundTransferCustomRefund(
      customL1Token.address,
      userL1Wallet.address,
      userL2Wallet.address,
      depositAmount,
      gasLimit,
      maxFeePerGas,
      userEncodedData,
      { value: nativeToken ? BigNumber.from(0) : tokenTotalFeeAmount }
    )

    // wait for L2 msg to be executed
    await waitOnL2Msg(depositTx)

    ///// checks
    expect(await router.getGateway(customL1Token.address)).to.be.eq(
      _l2Network.tokenBridge.l1CustomGateway
    )

    const l2TokenAddress = await router.calculateL2TokenAddress(
      customL1Token.address
    )

    l2Token = ERC20__factory.connect(l2TokenAddress, childProvider)
    expect(await l2Token.balanceOf(userL2Wallet.address)).to.be.eq(
      depositAmount
    )

    const userTokenBalanceAfter = await customL1Token.balanceOf(
      userL1Wallet.address
    )
    expect(userTokenBalanceBefore.sub(userTokenBalanceAfter)).to.be.eq(
      depositAmount
    )

    const gatewayTokenBalanceAfter = await customL1Token.balanceOf(
      _l2Network.tokenBridge.l1CustomGateway
    )
    expect(gatewayTokenBalanceAfter.sub(gatewayTokenBalanceBefore)).to.be.eq(
      depositAmount
    )

    const userNativeTokenBalanceAfter = nativeToken
      ? await nativeToken.balanceOf(userL1Wallet.address)
      : await parentProvider.getBalance(userL1Wallet.address)
    if (nativeToken) {
      expect(
        userNativeTokenBalanceBefore.sub(userNativeTokenBalanceAfter)
      ).to.be.eq(tokenTotalFeeAmount)
    } else {
      expect(
        userNativeTokenBalanceBefore.sub(userNativeTokenBalanceAfter)
      ).to.be.gte(tokenTotalFeeAmount.toNumber())
    }
    const bridgeNativeTokenBalanceAfter = nativeToken
      ? await nativeToken.balanceOf(_l2Network.ethBridge.bridge)
      : await parentProvider.getBalance(_l2Network.ethBridge.bridge)
    expect(
      bridgeNativeTokenBalanceAfter.sub(bridgeNativeTokenBalanceBefore)
    ).to.be.eq(tokenTotalFeeAmount)
  })

  it('can upgrade from bridged USDC to native USDC when eth is native token', async function () {
    /// test applicable only for eth based chains
    if (nativeToken) {
      return
    }

    /// create new L1 usdc gateway behind proxy
    const proxyAdminFac = await new ProxyAdmin__factory(
      deployerL1Wallet
    ).deploy()
    const proxyAdmin = await proxyAdminFac.deployed()
    const l1USDCCustomGatewayFactory = await new L1USDCCustomGateway__factory(
      deployerL1Wallet
    ).deploy()
    const l1USDCCustomGatewayLogic = await l1USDCCustomGatewayFactory.deployed()
    const tupFactory = await new TransparentUpgradeableProxy__factory(
      deployerL1Wallet
    ).deploy(l1USDCCustomGatewayLogic.address, proxyAdmin.address, '0x')
    const tup = await tupFactory.deployed()
    const l1USDCCustomGateway = L1USDCCustomGateway__factory.connect(
      tup.address,
      deployerL1Wallet
    )
    console.log('L1USDCCustomGateway address: ', l1USDCCustomGateway.address)

    /// create new L2 usdc gateway behind proxy
    const proxyAdminL2Fac = await new ProxyAdmin__factory(
      deployerL2Wallet
    ).deploy()
    const proxyAdminL2 = await proxyAdminL2Fac.deployed()
    const l2USDCCustomGatewayFactory = await new L2USDCCustomGateway__factory(
      deployerL2Wallet
    ).deploy()
    const l2USDCCustomGatewayLogic = await l2USDCCustomGatewayFactory.deployed()
    const tupL2Factory = await new TransparentUpgradeableProxy__factory(
      deployerL2Wallet
    ).deploy(l2USDCCustomGatewayLogic.address, proxyAdminL2.address, '0x')
    const tupL2 = await tupL2Factory.deployed()
    const l2USDCCustomGateway = L2USDCCustomGateway__factory.connect(
      tupL2.address,
      deployerL2Wallet
    )
    console.log('L2USDCCustomGateway address: ', l2USDCCustomGateway.address)

    /// create l1 usdc behind proxy
    const l1UsdcFactory = await new MockL1Usdc__factory(
      deployerL1Wallet
    ).deploy()
    const l1UsdcLogic = await l1UsdcFactory.deployed()
    const tupL1UsdcFactory = await new TransparentUpgradeableProxy__factory(
      deployerL1Wallet
    ).deploy(l1UsdcLogic.address, proxyAdmin.address, '0x')
    const tupL1Usdc = await tupL1UsdcFactory.deployed()
    const l1Usdc = MockL1Usdc__factory.connect(
      tupL1Usdc.address,
      deployerL1Wallet
    )
    await (await l1Usdc.initialize()).wait()
    console.log('L1 USDC address: ', l1Usdc.address)

    /// create l2 usdc behind proxy
    const l2UsdcLogic = await _deployBridgedUsdcToken(deployerL2Wallet)
    const tupL2UsdcFactory = await new TransparentUpgradeableProxy__factory(
      deployerL2Wallet
    ).deploy(l2UsdcLogic.address, proxyAdminL2.address, '0x')
    const tupL2Usdc = await tupL2UsdcFactory.deployed()
    const l2Usdc = BridgedUsdcCustomToken__factory.connect(
      tupL2Usdc.address,
      deployerL2Wallet
    )
    await (
      await l2Usdc.initialize(
        'Bridged USDC Orbit',
        l2USDCCustomGateway.address,
        l1Usdc.address
      )
    ).wait()
    console.log('L2 USDC address: ', l2Usdc.address)

    /// initialize gateways
    await (
      await l1USDCCustomGateway.initialize(
        l2USDCCustomGateway.address,
        _l2Network.tokenBridge.l1GatewayRouter,
        _l2Network.ethBridge.inbox,
        l1Usdc.address,
        l2Usdc.address,
        deployerL1Wallet.address
      )
    ).wait()
    console.log('L1 USDC custom gateway initialized')

    await (
      await l2USDCCustomGateway.initialize(
        l1USDCCustomGateway.address,
        _l2Network.tokenBridge.l2GatewayRouter,
        l1Usdc.address,
        l2Usdc.address,
        deployerL2Wallet.address
      )
    ).wait()
    console.log('L2 USDC custom gateway initialized')

    /// register USDC custom gateway
    const router = L1GatewayRouter__factory.connect(
      _l2Network.tokenBridge.l1GatewayRouter,
      deployerL1Wallet
    )
    const l2Router = L2GatewayRouter__factory.connect(
      _l2Network.tokenBridge.l2GatewayRouter,
      deployerL2Wallet
    )
    const maxGas = BigNumber.from(500000)
    const gasPriceBid = BigNumber.from(200000000)
    let maxSubmissionCost = BigNumber.from(257600000000)
    const registrationCalldata = router.interface.encodeFunctionData(
      'setGateways',
      [
        [l1Usdc.address],
        [l1USDCCustomGateway.address],
        maxGas,
        gasPriceBid,
        maxSubmissionCost,
      ]
    )
    const rollupOwner = new Wallet(LOCALHOST_L3_OWNER_KEY, parentProvider)
    const upExec = UpgradeExecutor__factory.connect(
      await IOwnable__factory.connect(
        _l2Network.ethBridge.rollup,
        deployerL1Wallet
      ).owner(),
      rollupOwner
    )
    const gwRegistrationTx = await upExec.executeCall(
      router.address,
      registrationCalldata,
      {
        value: maxGas.mul(gasPriceBid).add(maxSubmissionCost),
      }
    )
    await waitOnL2Msg(gwRegistrationTx)
    console.log('USDC custom gateway registered')

    /// check gateway registration
    expect(await router.getGateway(l1Usdc.address)).to.be.eq(
      l1USDCCustomGateway.address
    )
    expect(await l1USDCCustomGateway.depositsPaused()).to.be.eq(false)
    expect(await l2Router.getGateway(l1Usdc.address)).to.be.eq(
      l2USDCCustomGateway.address
    )
    expect(await l2USDCCustomGateway.withdrawalsPaused()).to.be.eq(false)

    /// do a deposit
    const depositAmount = ethers.utils.parseEther('2')
    await (await l1Usdc.transfer(userL1Wallet.address, depositAmount)).wait()
    await (
      await l1Usdc
        .connect(userL1Wallet)
        .approve(l1USDCCustomGateway.address, depositAmount)
    ).wait()
    maxSubmissionCost = BigNumber.from(334400000000)
    const depositTx = await router
      .connect(userL1Wallet)
      .outboundTransferCustomRefund(
        l1Usdc.address,
        userL2Wallet.address,
        userL2Wallet.address,
        depositAmount,
        maxGas,
        gasPriceBid,
        defaultAbiCoder.encode(['uint256', 'bytes'], [maxSubmissionCost, '0x']),
        { value: maxGas.mul(gasPriceBid).add(maxSubmissionCost) }
      )
    await waitOnL2Msg(depositTx)
    expect(await l2Usdc.balanceOf(userL2Wallet.address)).to.be.eq(depositAmount)
    expect(await l1Usdc.balanceOf(l1USDCCustomGateway.address)).to.be.eq(
      depositAmount
    )
    console.log('Deposited USDC')

    /// pause deposits
    await (await l1USDCCustomGateway.pauseDeposits()).wait()
    expect(await l1USDCCustomGateway.depositsPaused()).to.be.eq(true)

    /// pause withdrawals
    await (await l2USDCCustomGateway.pauseWithdrawals()).wait()
    expect(await l2USDCCustomGateway.withdrawalsPaused()).to.be.eq(true)

    /// transfer ownership to circle
    const circleWallet = ethers.Wallet.createRandom().connect(parentProvider)
    await (
      await deployerL1Wallet.sendTransaction({
        to: circleWallet.address,
        value: ethers.utils.parseEther('1'),
      })
    ).wait()

    await (await l1Usdc.setOwner(circleWallet.address)).wait()
    await (await l1USDCCustomGateway.setOwner(circleWallet.address)).wait()
    console.log('L1 USDC and L1 USDC gateway ownership transferred to circle')

    /// circle checks that deposits are paused, all in-flight deposits and withdrawals are processed

    /// add minter rights to usdc gateway so it can burn USDC
    await (
      await l1Usdc.connect(circleWallet).addMinter(l1USDCCustomGateway.address)
    ).wait()
    console.log('Minter rights added to USDC gateway')

    /// burn USDC
    await (
      await l1USDCCustomGateway.connect(circleWallet).burnLockedUSDC()
    ).wait()
    expect(await l1Usdc.balanceOf(l1USDCCustomGateway.address)).to.be.eq(0)
    expect(await l2Usdc.balanceOf(userL2Wallet.address)).to.be.eq(depositAmount)
    console.log('USDC burned')
  })

  it('can upgrade from bridged USDC to native USDC when fee token is used', async function () {
    /// test applicable only for fee token based chains
    if (!nativeToken) {
      return
    }

    /// create new L1 usdc gateway behind proxy
    const proxyAdminFac = await new ProxyAdmin__factory(
      deployerL1Wallet
    ).deploy()
    const proxyAdmin = await proxyAdminFac.deployed()
    const l1USDCCustomGatewayFactory =
      await new L1FeeTokenUSDCCustomGateway__factory(deployerL1Wallet).deploy()
    const l1USDCCustomGatewayLogic = await l1USDCCustomGatewayFactory.deployed()
    const tupFactory = await new TransparentUpgradeableProxy__factory(
      deployerL1Wallet
    ).deploy(l1USDCCustomGatewayLogic.address, proxyAdmin.address, '0x')
    const tup = await tupFactory.deployed()
    const l1USDCCustomGateway = L1USDCCustomGateway__factory.connect(
      tup.address,
      deployerL1Wallet
    )
    console.log('L1USDCCustomGateway address: ', l1USDCCustomGateway.address)

    /// create new L2 usdc gateway behind proxy
    const proxyAdminL2Fac = await new ProxyAdmin__factory(
      deployerL2Wallet
    ).deploy()
    const proxyAdminL2 = await proxyAdminL2Fac.deployed()
    const l2USDCCustomGatewayFactory = await new L2USDCCustomGateway__factory(
      deployerL2Wallet
    ).deploy()
    const l2USDCCustomGatewayLogic = await l2USDCCustomGatewayFactory.deployed()
    const tupL2Factory = await new TransparentUpgradeableProxy__factory(
      deployerL2Wallet
    ).deploy(l2USDCCustomGatewayLogic.address, proxyAdminL2.address, '0x')
    const tupL2 = await tupL2Factory.deployed()
    const l2USDCCustomGateway = L2USDCCustomGateway__factory.connect(
      tupL2.address,
      deployerL2Wallet
    )
    console.log('L2USDCCustomGateway address: ', l2USDCCustomGateway.address)

    /// create l1 usdc behind proxy
    const l1UsdcFactory = await new MockL1Usdc__factory(
      deployerL1Wallet
    ).deploy()
    const l1UsdcLogic = await l1UsdcFactory.deployed()
    const tupL1UsdcFactory = await new TransparentUpgradeableProxy__factory(
      deployerL1Wallet
    ).deploy(l1UsdcLogic.address, proxyAdmin.address, '0x')
    const tupL1Usdc = await tupL1UsdcFactory.deployed()
    const l1Usdc = MockL1Usdc__factory.connect(
      tupL1Usdc.address,
      deployerL1Wallet
    )
    await (await l1Usdc.initialize()).wait()
    console.log('L1 USDC address: ', l1Usdc.address)

    /// create l2 usdc behind proxy
    const l2UsdcLogic = await _deployBridgedUsdcToken(deployerL2Wallet)
    const tupL2UsdcFactory = await new TransparentUpgradeableProxy__factory(
      deployerL2Wallet
    ).deploy(l2UsdcLogic.address, proxyAdminL2.address, '0x')
    const tupL2Usdc = await tupL2UsdcFactory.deployed()
    const l2Usdc = BridgedUsdcCustomToken__factory.connect(
      tupL2Usdc.address,
      deployerL2Wallet
    )
    await (
      await l2Usdc.initialize(
        'Bridged USDC Orbit',
        l2USDCCustomGateway.address,
        l1Usdc.address
      )
    ).wait()
    console.log('L2 USDC address: ', l2Usdc.address)

    /// initialize gateways
    await (
      await l1USDCCustomGateway.initialize(
        l2USDCCustomGateway.address,
        _l2Network.tokenBridge.l1GatewayRouter,
        _l2Network.ethBridge.inbox,
        l1Usdc.address,
        l2Usdc.address,
        deployerL1Wallet.address
      )
    ).wait()
    console.log('L1 USDC custom gateway initialized')

    await (
      await l2USDCCustomGateway.initialize(
        l1USDCCustomGateway.address,
        _l2Network.tokenBridge.l2GatewayRouter,
        l1Usdc.address,
        l2Usdc.address,
        deployerL2Wallet.address
      )
    ).wait()
    console.log('L2 USDC custom gateway initialized')

    /// register USDC custom gateway
    const router = L1OrbitGatewayRouter__factory.connect(
      _l2Network.tokenBridge.l1GatewayRouter,
      deployerL1Wallet
    )
    const l2Router = L2GatewayRouter__factory.connect(
      _l2Network.tokenBridge.l2GatewayRouter,
      deployerL2Wallet
    )
    const maxGas = BigNumber.from(500000)
    const gasPriceBid = BigNumber.from(200000000)
    const totalFeeTokenAmount = maxGas.mul(gasPriceBid)
    const maxSubmissionCost = BigNumber.from(0)

    // prefund inbox to pay for registration
    await (
      await nativeToken
        .connect(deployerL1Wallet)
        .transfer(_l2Network.ethBridge.inbox, totalFeeTokenAmount)
    ).wait()

    const registrationCalldata = (router.interface as any).encodeFunctionData(
      'setGateways(address[],address[],uint256,uint256,uint256,uint256)',
      [
        [l1Usdc.address],
        [l1USDCCustomGateway.address],
        maxGas,
        gasPriceBid,
        maxSubmissionCost,
        totalFeeTokenAmount,
      ]
    )
    const rollupOwner = new Wallet(LOCALHOST_L3_OWNER_KEY, parentProvider)

    // approve fee amount
    console.log('Approving fee amount')
    await (
      await nativeToken
        .connect(rollupOwner)
        .approve(l1USDCCustomGateway.address, totalFeeTokenAmount)
    ).wait()

    const upExec = UpgradeExecutor__factory.connect(
      await IOwnable__factory.connect(
        _l2Network.ethBridge.rollup,
        deployerL1Wallet
      ).owner(),
      rollupOwner
    )
    const gwRegistrationTx = await upExec.executeCall(
      router.address,
      registrationCalldata
    )
    await waitOnL2Msg(gwRegistrationTx)
    console.log('USDC custom gateway registered')

    /// check gateway registration
    expect(await router.getGateway(l1Usdc.address)).to.be.eq(
      l1USDCCustomGateway.address
    )
    expect(await l1USDCCustomGateway.depositsPaused()).to.be.eq(false)
    expect(await l2Router.getGateway(l1Usdc.address)).to.be.eq(
      l2USDCCustomGateway.address
    )
    expect(await l2USDCCustomGateway.withdrawalsPaused()).to.be.eq(false)

    /// do a deposit
    const depositAmount = ethers.utils.parseEther('2')
    await (await l1Usdc.transfer(userL1Wallet.address, depositAmount)).wait()
    await (
      await l1Usdc
        .connect(userL1Wallet)
        .approve(l1USDCCustomGateway.address, depositAmount)
    ).wait()

    // approve fee amount
    await (
      await nativeToken
        .connect(userL1Wallet)
        .approve(l1USDCCustomGateway.address, totalFeeTokenAmount)
    ).wait()

    const depositTx = await router
      .connect(userL1Wallet)
      .outboundTransferCustomRefund(
        l1Usdc.address,
        userL2Wallet.address,
        userL2Wallet.address,
        depositAmount,
        maxGas,
        gasPriceBid,
        defaultAbiCoder.encode(
          ['uint256', 'bytes', 'uint256'],
          [maxSubmissionCost, '0x', totalFeeTokenAmount]
        )
      )
    await waitOnL2Msg(depositTx)
    expect(await l2Usdc.balanceOf(userL2Wallet.address)).to.be.eq(depositAmount)
    expect(await l1Usdc.balanceOf(l1USDCCustomGateway.address)).to.be.eq(
      depositAmount
    )
    console.log('Deposited USDC')

    /// pause deposits
    await (await l1USDCCustomGateway.pauseDeposits()).wait()
    expect(await l1USDCCustomGateway.depositsPaused()).to.be.eq(true)

    /// pause withdrawals
    await (await l2USDCCustomGateway.pauseWithdrawals()).wait()
    expect(await l2USDCCustomGateway.withdrawalsPaused()).to.be.eq(true)

    /// transfer ownership to circle
    const circleWallet = ethers.Wallet.createRandom().connect(parentProvider)
    await (
      await deployerL1Wallet.sendTransaction({
        to: circleWallet.address,
        value: ethers.utils.parseEther('1'),
      })
    ).wait()

    await (await l1Usdc.setOwner(circleWallet.address)).wait()
    await (await l1USDCCustomGateway.setOwner(circleWallet.address)).wait()
    console.log('L1 USDC and L1 USDC gateway ownership transferred to circle')

    /// circle checks that deposits are paused, all in-flight deposits and withdrawals are processed

    /// add minter rights to usdc gateway so it can burn USDC
    await (
      await l1Usdc.connect(circleWallet).addMinter(l1USDCCustomGateway.address)
    ).wait()
    console.log('Minter rights added to USDC gateway')

    /// burn USDC
    await (
      await l1USDCCustomGateway.connect(circleWallet).burnLockedUSDC()
    ).wait()
    expect(await l1Usdc.balanceOf(l1USDCCustomGateway.address)).to.be.eq(0)
    expect(await l2Usdc.balanceOf(userL2Wallet.address)).to.be.eq(depositAmount)
    console.log('USDC burned')
  })
})

/**
 * helper function to fund user wallet on L2
 */
async function depositNativeToL2() {
  /// deposit tokens
  const amountToDeposit = ethers.utils.parseEther('2.0')
  await (
    await nativeToken!
      .connect(userL1Wallet)
      .approve(_l2Network.ethBridge.inbox, amountToDeposit)
  ).wait()

  const depositFuncSig = {
    name: 'depositERC20',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'amount',
        type: 'uint256',
      },
    ],
  }
  const inbox = new ethers.Contract(
    _l2Network.ethBridge.inbox,
    [depositFuncSig],
    userL1Wallet
  )

  const depositTx = await inbox.depositERC20(amountToDeposit)

  // wait for deposit to be processed
  const depositRec = await L1TransactionReceipt.monkeyPatchEthDepositWait(
    depositTx
  ).wait()
  await depositRec.waitForL2(childProvider)
}

async function waitOnL2Msg(tx: ethers.ContractTransaction) {
  const retryableReceipt = await tx.wait()
  const l1TxReceipt = new L1TransactionReceipt(retryableReceipt)
  const messages = await l1TxReceipt.getL1ToL2Messages(childProvider)

  // 1 msg expected
  const messageResult = await messages[0].waitForStatus()
  const status = messageResult.status
  expect(status).to.be.eq(L1ToL2MessageStatus.REDEEMED)
}

const getFeeToken = async (inbox: string, parentProvider: any) => {
  const bridge = await IInbox__factory.connect(inbox, parentProvider).bridge()

  let feeToken = ethers.constants.AddressZero

  try {
    feeToken = await IERC20Bridge__factory.connect(
      bridge,
      parentProvider
    ).nativeToken()
  } catch {}

  return feeToken
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function _deployBridgedUsdcToken(deployer: Wallet) {
  /// deploy library
  const sigCheckerLibBytecode =
    '6106cd610026600b82828239805160001a60731461001957fe5b30600052607381538281f3fe73000000000000000000000000000000000000000030146080604052600436106100355760003560e01c80636ccea6521461003a575b600080fd5b6101026004803603606081101561005057600080fd5b73ffffffffffffffffffffffffffffffffffffffff8235169160208101359181019060608101604082013564010000000081111561008d57600080fd5b82018360208201111561009f57600080fd5b803590602001918460018302840111640100000000831117156100c157600080fd5b91908080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250929550610116945050505050565b604080519115158252519081900360200190f35b600061012184610179565b610164578373ffffffffffffffffffffffffffffffffffffffff16610146848461017f565b73ffffffffffffffffffffffffffffffffffffffff16149050610172565b61016f848484610203565b90505b9392505050565b3b151590565b600081516041146101db576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260238152602001806106296023913960400191505060405180910390fd5b60208201516040830151606084015160001a6101f98682858561042d565b9695505050505050565b60008060608573ffffffffffffffffffffffffffffffffffffffff16631626ba7e60e01b86866040516024018083815260200180602001828103825283818151815260200191508051906020019080838360005b8381101561026f578181015183820152602001610257565b50505050905090810190601f16801561029c5780820380516001836020036101000a031916815260200191505b50604080517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe08184030181529181526020820180517bffffffffffffffffffffffffffffffffffffffffffffffffffffffff167fffffffff000000000000000000000000000000000000000000000000000000009098169790971787525181519196909550859450925090508083835b6020831061036957805182527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0909201916020918201910161032c565b6001836020036101000a038019825116818451168082178552505050505050905001915050600060405180830381855afa9150503d80600081146103c9576040519150601f19603f3d011682016040523d82523d6000602084013e6103ce565b606091505b50915091508180156103e257506020815110155b80156101f9575080517f1626ba7e00000000000000000000000000000000000000000000000000000000906020808401919081101561042057600080fd5b5051149695505050505050565b60007f7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a08211156104a8576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260268152602001806106726026913960400191505060405180910390fd5b8360ff16601b141580156104c057508360ff16601c14155b15610516576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602681526020018061064c6026913960400191505060405180910390fd5b600060018686868660405160008152602001604052604051808581526020018460ff1681526020018381526020018281526020019450505050506020604051602081039080840390855afa158015610572573d6000803e3d6000fd5b50506040517fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0015191505073ffffffffffffffffffffffffffffffffffffffff811661061f57604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601c60248201527f45435265636f7665723a20696e76616c6964207369676e617475726500000000604482015290519081900360640190fd5b9594505050505056fe45435265636f7665723a20696e76616c6964207369676e6174757265206c656e67746845435265636f7665723a20696e76616c6964207369676e6174757265202776272076616c756545435265636f7665723a20696e76616c6964207369676e6174757265202773272076616c7565a2646970667358221220fc883ef3b50f607958f5dc584d21cf2984d25712b89b5e11c0d53a81068ace3664736f6c634300060c0033'
  const sigCheckerFactory = new ethers.ContractFactory(
    [],
    sigCheckerLibBytecode,
    deployer
  )
  const sigCheckerLib = await sigCheckerFactory.deploy()

  // prepare bridged usdc bytecode
  const bytecodeWithPlaceholder =
    '60806040526001805460ff60a01b191690556000600b553480156200002357600080fd5b506200002f3362000035565b62000057565b600080546001600160a01b0319166001600160a01b0392909216919091179055565b61632680620000676000396000f3fe608060405234801561001057600080fd5b50600436106103a45760003560e01c80638a6db9c3116101e9578063b7b728991161010f578063dd62ed3e116100ad578063ef55bec61161007c578063ef55bec614611216578063f2fde38b14611282578063f9f92be4146112b5578063fe575a87146112e8576103a4565b8063dd62ed3e1461112e578063e3ee160e14611169578063e5a6b10f146111d5578063e94a0102146111dd576103a4565b8063cf092995116100e9578063cf09299514610f74578063d505accf14611058578063d608ea64146110b6578063d916948714611126576103a4565b8063b7b7289914610e9c578063bd10243014610f64578063c2eeeebd14610f6c576103a4565b8063a0cc6a6811610187578063aa20e1e411610156578063aa20e1e414610dc0578063aa271e1a14610df3578063ad38bf2214610e26578063b2118a8d14610e59576103a4565b8063a0cc6a6814610d0b578063a297ea5e14610d13578063a457c2d714610d4e578063a9059cbb14610d87576103a4565b80638fa74a0e116101c35780638fa74a0e14610c1b57806395d89b4114610c235780639fd0506d14610c2b5780639fd5a6cf14610c33576103a4565b80638a6db9c314610ba75780638c2a993e14610bda5780638da5cb5b14610c13576103a4565b80633f4ba83a116102ce5780635a049a701161026c5780637ecebe001161023b5780637ecebe0014610a805780637f2eecc314610ab35780638456cb5914610abb57806388b7ab6314610ac3576103a4565b80635a049a70146109be5780635c975abb14610a0c57806370a0823114610a1457806374f4f54714610a47576103a4565b8063430239b4116102a8578063430239b4146108885780634e44d9561461094a57806354fd4d5014610983578063554bab3c1461098b576103a4565b80633f4ba83a1461082a57806340c10f191461083257806342966c681461086b576103a4565b80633092afd51161034657806335d99f351161031557806335d99f35146107b05780633644e515146107e157806338a63183146107e957806339509351146107f1576103a4565b80633092afd51461056b57806330adf81f1461059e578063313ce567146105a65780633357162b146105c4576103a4565b80631a895266116103825780631a8952661461048d57806323b872dd146104c25780632ab60045146105055780632fc81e0914610538576103a4565b806306fdde03146103a9578063095ea7b31461042657806318160ddd14610473575b600080fd5b6103b161131b565b6040805160208082528351818301528351919283929083019185019080838360005b838110156103eb5781810151838201526020016103d3565b50505050905090810190601f1680156104185780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b61045f6004803603604081101561043c57600080fd5b5073ffffffffffffffffffffffffffffffffffffffff81351690602001356113c7565b604080519115158252519081900360200190f35b61047b611468565b60408051918252519081900360200190f35b6104c0600480360360208110156104a357600080fd5b503573ffffffffffffffffffffffffffffffffffffffff1661146e565b005b61045f600480360360608110156104d857600080fd5b5073ffffffffffffffffffffffffffffffffffffffff81358116916020810135909116906040013561152b565b6104c06004803603602081101561051b57600080fd5b503573ffffffffffffffffffffffffffffffffffffffff166117e6565b6104c06004803603602081101561054e57600080fd5b503573ffffffffffffffffffffffffffffffffffffffff16611947565b61045f6004803603602081101561058157600080fd5b503573ffffffffffffffffffffffffffffffffffffffff166119af565b61047b611aa8565b6105ae611acc565b6040805160ff9092168252519081900360200190f35b6104c060048036036101008110156105db57600080fd5b8101906020810181356401000000008111156105f657600080fd5b82018360208201111561060857600080fd5b8035906020019184600183028401116401000000008311171561062a57600080fd5b91908080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250929594936020810193503591505064010000000081111561067d57600080fd5b82018360208201111561068f57600080fd5b803590602001918460018302840111640100000000831117156106b157600080fd5b91908080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250929594936020810193503591505064010000000081111561070457600080fd5b82018360208201111561071657600080fd5b8035906020019184600183028401116401000000008311171561073857600080fd5b91908080601f0160208091040260200160405190810160405280939291908181526020018383808284376000920191909152509295505050813560ff16925050602081013573ffffffffffffffffffffffffffffffffffffffff90811691604081013582169160608201358116916080013516611ad5565b6107b8611e17565b6040805173ffffffffffffffffffffffffffffffffffffffff9092168252519081900360200190f35b61047b611e33565b6107b8611e42565b61045f6004803603604081101561080757600080fd5b5073ffffffffffffffffffffffffffffffffffffffff8135169060200135611e5e565b6104c0611ef6565b61045f6004803603604081101561084857600080fd5b5073ffffffffffffffffffffffffffffffffffffffff8135169060200135611fb9565b6104c06004803603602081101561088157600080fd5b503561238a565b6104c06004803603604081101561089e57600080fd5b8101906020810181356401000000008111156108b957600080fd5b8201836020820111156108cb57600080fd5b803590602001918460208302840111640100000000831117156108ed57600080fd5b91939092909160208101903564010000000081111561090b57600080fd5b82018360208201111561091d57600080fd5b8035906020019184600183028401116401000000008311171561093f57600080fd5b50909250905061262c565b61045f6004803603604081101561096057600080fd5b5073ffffffffffffffffffffffffffffffffffffffff81351690602001356127e3565b6103b1612976565b6104c0600480360360208110156109a157600080fd5b503573ffffffffffffffffffffffffffffffffffffffff166129ad565b6104c0600480360360a08110156109d457600080fd5b5073ffffffffffffffffffffffffffffffffffffffff8135169060208101359060ff6040820135169060608101359060800135612b14565b61045f612bb2565b61047b60048036036020811015610a2a57600080fd5b503573ffffffffffffffffffffffffffffffffffffffff16612bd3565b6104c060048036036040811015610a5d57600080fd5b5073ffffffffffffffffffffffffffffffffffffffff8135169060200135612be4565b61047b60048036036020811015610a9657600080fd5b503573ffffffffffffffffffffffffffffffffffffffff16612c93565b61047b612cbb565b6104c0612cdf565b6104c0600480360360e0811015610ad957600080fd5b73ffffffffffffffffffffffffffffffffffffffff823581169260208101359091169160408201359160608101359160808201359160a08101359181019060e0810160c0820135640100000000811115610b3257600080fd5b820183602082011115610b4457600080fd5b80359060200191846001830284011164010000000083111715610b6657600080fd5b91908080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250929550612db9945050505050565b61047b60048036036020811015610bbd57600080fd5b503573ffffffffffffffffffffffffffffffffffffffff16612f1d565b6104c060048036036040811015610bf057600080fd5b5073ffffffffffffffffffffffffffffffffffffffff8135169060200135612f45565b6107b8612ff5565b6107b8613011565b6103b1613036565b6107b86130af565b6104c0600480360360a0811015610c4957600080fd5b73ffffffffffffffffffffffffffffffffffffffff823581169260208101359091169160408201359160608101359181019060a081016080820135640100000000811115610c9657600080fd5b820183602082011115610ca857600080fd5b80359060200191846001830284011164010000000083111715610cca57600080fd5b91908080601f0160208091040260200160405190810160405280939291908181526020018383808284376000920191909152509295506130cb945050505050565b61047b613162565b6104c060048036036040811015610d2957600080fd5b5073ffffffffffffffffffffffffffffffffffffffff81358116916020013516613186565b61045f60048036036040811015610d6457600080fd5b5073ffffffffffffffffffffffffffffffffffffffff81351690602001356132f5565b61045f60048036036040811015610d9d57600080fd5b5073ffffffffffffffffffffffffffffffffffffffff813516906020013561338d565b6104c060048036036020811015610dd657600080fd5b503573ffffffffffffffffffffffffffffffffffffffff166134f0565b61045f60048036036020811015610e0957600080fd5b503573ffffffffffffffffffffffffffffffffffffffff16613657565b6104c060048036036020811015610e3c57600080fd5b503573ffffffffffffffffffffffffffffffffffffffff16613682565b6104c060048036036060811015610e6f57600080fd5b5073ffffffffffffffffffffffffffffffffffffffff8135811691602081013590911690604001356137e9565b6104c060048036036060811015610eb257600080fd5b73ffffffffffffffffffffffffffffffffffffffff82351691602081013591810190606081016040820135640100000000811115610eef57600080fd5b820183602082011115610f0157600080fd5b80359060200191846001830284011164010000000083111715610f2357600080fd5b91908080601f01602080910402602001604051908101604052809392919081815260200183838082843760009201919091525092955061387a945050505050565b6107b861390f565b6107b861392b565b6104c0600480360360e0811015610f8a57600080fd5b73ffffffffffffffffffffffffffffffffffffffff823581169260208101359091169160408201359160608101359160808201359160a08101359181019060e0810160c0820135640100000000811115610fe357600080fd5b820183602082011115610ff557600080fd5b8035906020019184600183028401116401000000008311171561101757600080fd5b91908080601f016020809104026020016040519081016040528093929190818152602001838380828437600092019190915250929550613950945050505050565b6104c0600480360360e081101561106e57600080fd5b5073ffffffffffffffffffffffffffffffffffffffff813581169160208101359091169060408101359060608101359060ff6080820135169060a08101359060c00135613aa9565b6104c0600480360360208110156110cc57600080fd5b8101906020810181356401000000008111156110e757600080fd5b8201836020820111156110f957600080fd5b8035906020019184600183028401116401000000008311171561111b57600080fd5b509092509050613b4b565b61047b613c34565b61047b6004803603604081101561114457600080fd5b5073ffffffffffffffffffffffffffffffffffffffff81358116916020013516613c58565b6104c0600480360361012081101561118057600080fd5b5073ffffffffffffffffffffffffffffffffffffffff813581169160208101359091169060408101359060608101359060808101359060a08101359060ff60c0820135169060e0810135906101000135613c90565b6103b1613df8565b61045f600480360360408110156111f357600080fd5b5073ffffffffffffffffffffffffffffffffffffffff8135169060200135613e71565b6104c0600480360361012081101561122d57600080fd5b5073ffffffffffffffffffffffffffffffffffffffff813581169160208101359091169060408101359060608101359060808101359060a08101359060ff60c0820135169060e0810135906101000135613ea9565b6104c06004803603602081101561129857600080fd5b503573ffffffffffffffffffffffffffffffffffffffff16614004565b6104c0600480360360208110156112cb57600080fd5b503573ffffffffffffffffffffffffffffffffffffffff16614157565b61045f600480360360208110156112fe57600080fd5b503573ffffffffffffffffffffffffffffffffffffffff16614214565b6004805460408051602060026001851615610100027fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0190941693909304601f810184900484028201840190925281815292918301828280156113bf5780601f10611394576101008083540402835291602001916113bf565b820191906000526020600020905b8154815290600101906020018083116113a257829003601f168201915b505050505081565b60015460009074010000000000000000000000000000000000000000900460ff161561145457604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b61145f33848461421f565b50600192915050565b600b5490565b60025473ffffffffffffffffffffffffffffffffffffffff1633146114de576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602c815260200180615fa2602c913960400191505060405180910390fd5b6114e781614366565b60405173ffffffffffffffffffffffffffffffffffffffff8216907f117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e90600090a250565b60015460009074010000000000000000000000000000000000000000900460ff16156115b857604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b336115c281614371565b15611618576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162826025913960400191505060405180910390fd5b8461162281614371565b15611678576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162826025913960400191505060405180910390fd5b8461168281614371565b156116d8576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162826025913960400191505060405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff87166000908152600a60209081526040808320338452909152902054851115611761576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260288152602001806160926028913960400191505060405180910390fd5b61176c87878761439f565b73ffffffffffffffffffffffffffffffffffffffff87166000908152600a602090815260408083203384529091529020546117a7908661456a565b73ffffffffffffffffffffffffffffffffffffffff88166000908152600a60209081526040808320338452909152902055600193505050509392505050565b60005473ffffffffffffffffffffffffffffffffffffffff16331461186c57604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015290519081900360640190fd5b73ffffffffffffffffffffffffffffffffffffffff81166118d8576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602a815260200180615edb602a913960400191505060405180910390fd5b600e80547fffffffffffffffffffffffff00000000000000000000000000000000000000001673ffffffffffffffffffffffffffffffffffffffff83169081179091556040517fe475e580d85111348e40d8ca33cfdd74c30fe1655c2d8537a13abc10065ffa5a90600090a250565b60125460ff1660011461195957600080fd5b6000611964306145e1565b905080156119775761197730838361439f565b6119803061462b565b5050601280547fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00166002179055565b60085460009073ffffffffffffffffffffffffffffffffffffffff163314611a22576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401808060200182810382526029815260200180615f796029913960400191505060405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff82166000818152600c6020908152604080832080547fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00169055600d909152808220829055517fe94479a9f7e1952cc78f2d6baab678adc1b772d936c6583def489e524cb666929190a2506001919050565b7f6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c981565b60065460ff1681565b60085474010000000000000000000000000000000000000000900460ff1615611b49576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602a81526020018061610d602a913960400191505060405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff8416611bb5576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602f81526020018061603f602f913960400191505060405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff8316611c21576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401808060200182810382526029815260200180615eb26029913960400191505060405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff8216611c8d576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602e8152602001806160ba602e913960400191505060405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff8116611cf9576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260288152602001806161fa6028913960400191505060405180910390fd5b8751611d0c9060049060208b0190615c4b565b508651611d209060059060208a0190615c4b565b508551611d34906007906020890190615c4b565b50600680547fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff001660ff8716179055600880547fffffffffffffffffffffffff000000000000000000000000000000000000000090811673ffffffffffffffffffffffffffffffffffffffff8781169190911790925560018054821686841617905560028054909116918416919091179055611dce81614636565b5050600880547fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff1674010000000000000000000000000000000000000000179055505050505050565b60085473ffffffffffffffffffffffffffffffffffffffff1681565b6000611e3d61467d565b905090565b600e5473ffffffffffffffffffffffffffffffffffffffff1690565b60015460009074010000000000000000000000000000000000000000900460ff1615611eeb57604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b61145f338484614772565b60015473ffffffffffffffffffffffffffffffffffffffff163314611f66576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806161ae6022913960400191505060405180910390fd5b600180547fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff1690556040517f7805862f689e2f13df9f062ff482ad3ad112aca9e0847911ed832e158c525b3390600090a1565b60015460009074010000000000000000000000000000000000000000900460ff161561204657604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b336000908152600c602052604090205460ff166120ae576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602181526020018061601e6021913960400191505060405180910390fd5b336120b881614371565b1561210e576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162826025913960400191505060405180910390fd5b8361211881614371565b1561216e576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162826025913960400191505060405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff85166121da576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401808060200182810382526023815260200180615e476023913960400191505060405180910390fd5b60008411612233576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401808060200182810382526029815260200180615f2a6029913960400191505060405180910390fd5b336000908152600d60205260409020548085111561229c576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602e815260200180616180602e913960400191505060405180910390fd5b600b546122a990866147bc565b600b556122c8866122c3876122bd836145e1565b906147bc565b614837565b6122d2818661456a565b336000818152600d6020908152604091829020939093558051888152905173ffffffffffffffffffffffffffffffffffffffff8a16937fab8530f87dc9b59234c4623bf917212bb2536d647574c8e7e5da92c2ede0c9f8928290030190a360408051868152905173ffffffffffffffffffffffffffffffffffffffff8816916000917fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9181900360200190a350600195945050505050565b60015474010000000000000000000000000000000000000000900460ff161561241457604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b336000908152600c602052604090205460ff1661247c576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602181526020018061601e6021913960400191505060405180910390fd5b3361248681614371565b156124dc576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162826025913960400191505060405180910390fd5b60006124e7336145e1565b905060008311612542576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401808060200182810382526029815260200180615e1e6029913960400191505060405180910390fd5b8281101561259b576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401808060200182810382526026815260200180615ff86026913960400191505060405180910390fd5b600b546125a8908461456a565b600b556125b9336122c3838661456a565b60408051848152905133917fcc16f5dbb4873280815c1ee09dbd06736cffcc184412cf7a71a0fdb75d397ca5919081900360200190a260408051848152905160009133917fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9181900360200190a3505050565b60125460ff1660021461263e57600080fd5b61264a60058383615cc9565b5060005b8381101561278c576003600086868481811061266657fe5b6020908102929092013573ffffffffffffffffffffffffffffffffffffffff168352508101919091526040016000205460ff166126ee576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252603d815260200180615d6b603d913960400191505060405180910390fd5b61271f8585838181106126fd57fe5b9050602002013573ffffffffffffffffffffffffffffffffffffffff1661462b565b6003600086868481811061272f57fe5b6020908102929092013573ffffffffffffffffffffffffffffffffffffffff1683525081019190915260400160002080547fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0016905560010161264e565b506127963061462b565b505030600090815260036020819052604090912080547fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff009081169091556012805490911690911790555050565b60015460009074010000000000000000000000000000000000000000900460ff161561287057604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b60085473ffffffffffffffffffffffffffffffffffffffff1633146128e0576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401808060200182810382526029815260200180615f796029913960400191505060405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff83166000818152600c6020908152604080832080547fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00166001179055600d825291829020859055815185815291517f46980fca912ef9bcdbd36877427b6b90e860769f604e89c0e67720cece530d209281900390910190a250600192915050565b60408051808201909152600181527f3200000000000000000000000000000000000000000000000000000000000000602082015290565b60005473ffffffffffffffffffffffffffffffffffffffff163314612a3357604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015290519081900360640190fd5b73ffffffffffffffffffffffffffffffffffffffff8116612a9f576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401808060200182810382526028815260200180615dcb6028913960400191505060405180910390fd5b600180547fffffffffffffffffffffffff00000000000000000000000000000000000000001673ffffffffffffffffffffffffffffffffffffffff83811691909117918290556040519116907fb80482a293ca2e013eda8683c9bd7fc8347cfdaeea5ede58cba46df502c2a60490600090a250565b60015474010000000000000000000000000000000000000000900460ff1615612b9e57604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b612bab8585858585614938565b5050505050565b60015474010000000000000000000000000000000000000000900460ff1681565b6000612bde826145e1565b92915050565b612bec613011565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614612c8557604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152600c60248201527f4f4e4c595f474154455741590000000000000000000000000000000000000000604482015290519081900360640190fd5b612c8f8282614978565b5050565b73ffffffffffffffffffffffffffffffffffffffff1660009081526011602052604090205490565b7fd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de881565b60015473ffffffffffffffffffffffffffffffffffffffff163314612d4f576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806161ae6022913960400191505060405180910390fd5b600180547fffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffff16740100000000000000000000000000000000000000001790556040517f6985a02210a168e66602d3235cb6db0e70f92b3ba4d376a33c0f3d9434bff62590600090a1565b60015474010000000000000000000000000000000000000000900460ff1615612e4357604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b86612e4d81614371565b15612ea3576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162826025913960400191505060405180910390fd5b86612ead81614371565b15612f03576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162826025913960400191505060405180910390fd5b612f1289898989898989614c3e565b505050505050505050565b73ffffffffffffffffffffffffffffffffffffffff166000908152600d602052604090205490565b612f4d613011565b73ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff1614612fe657604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152600c60248201527f4f4e4c595f474154455741590000000000000000000000000000000000000000604482015290519081900360640190fd5b612ff08282611fb9565b505050565b60005473ffffffffffffffffffffffffffffffffffffffff1690565b7fdbf6298cab77bb44ebfd5abb25ed2538c2a55f7404c47e83e6531361fba28c245490565b6005805460408051602060026001851615610100027fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0190941693909304601f810184900484028201840190925281815292918301828280156113bf5780601f10611394576101008083540402835291602001916113bf565b60015473ffffffffffffffffffffffffffffffffffffffff1681565b60015474010000000000000000000000000000000000000000900460ff161561315557604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b612bab8585858585614d5f565b7f7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a226781565b60125460ff1660031461319857600080fd5b73ffffffffffffffffffffffffffffffffffffffff821661321a57604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152600f60248201527f494e56414c49445f474154455741590000000000000000000000000000000000604482015290519081900360640190fd5b6000613224613011565b73ffffffffffffffffffffffffffffffffffffffff16146132a657604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152600c60248201527f414c52454144595f494e49540000000000000000000000000000000000000000604482015290519081900360640190fd5b817fdbf6298cab77bb44ebfd5abb25ed2538c2a55f7404c47e83e6531361fba28c2455807f54352c0d7cc5793352a36344bfdcdcf68ba6258544ce1aed71f60a74d882c19155612c8f82615023565b60015460009074010000000000000000000000000000000000000000900460ff161561338257604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b61145f3384846150d8565b60015460009074010000000000000000000000000000000000000000900460ff161561341a57604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b3361342481614371565b1561347a576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162826025913960400191505060405180910390fd5b8361348481614371565b156134da576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162826025913960400191505060405180910390fd5b6134e533868661439f565b506001949350505050565b60005473ffffffffffffffffffffffffffffffffffffffff16331461357657604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015290519081900360640190fd5b73ffffffffffffffffffffffffffffffffffffffff81166135e2576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602f81526020018061603f602f913960400191505060405180910390fd5b600880547fffffffffffffffffffffffff00000000000000000000000000000000000000001673ffffffffffffffffffffffffffffffffffffffff83811691909117918290556040519116907fdb66dfa9c6b8f5226fe9aac7e51897ae8ee94ac31dc70bb6c9900b2574b707e690600090a250565b73ffffffffffffffffffffffffffffffffffffffff166000908152600c602052604090205460ff1690565b60005473ffffffffffffffffffffffffffffffffffffffff16331461370857604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015290519081900360640190fd5b73ffffffffffffffffffffffffffffffffffffffff8116613774576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260328152602001806162506032913960400191505060405180910390fd5b600280547fffffffffffffffffffffffff00000000000000000000000000000000000000001673ffffffffffffffffffffffffffffffffffffffff83811691909117918290556040519116907fc67398012c111ce95ecb7429b933096c977380ee6c421175a71a4a4c6c88c06e90600090a250565b600e5473ffffffffffffffffffffffffffffffffffffffff163314613859576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602481526020018061606e6024913960400191505060405180910390fd5b612ff073ffffffffffffffffffffffffffffffffffffffff84168383615134565b60015474010000000000000000000000000000000000000000900460ff161561390457604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b612ff08383836151c1565b60025473ffffffffffffffffffffffffffffffffffffffff1681565b7f54352c0d7cc5793352a36344bfdcdcf68ba6258544ce1aed71f60a74d882c1915490565b60015474010000000000000000000000000000000000000000900460ff16156139da57604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b866139e481614371565b15613a3a576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162826025913960400191505060405180910390fd5b86613a4481614371565b15613a9a576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162826025913960400191505060405180910390fd5b612f12898989898989896152cb565b60015474010000000000000000000000000000000000000000900460ff1615613b3357604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b613b4287878787878787615369565b50505050505050565b60085474010000000000000000000000000000000000000000900460ff168015613b78575060125460ff16155b613b8157600080fd5b613b8d60048383615cc9565b50613c0282828080601f0160208091040260200160405190810160405280939291908181526020018383808284376000920191909152505060408051808201909152600181527f3200000000000000000000000000000000000000000000000000000000000000602082015291506153ab9050565b600f555050601280547fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00166001179055565b7f158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a159742981565b73ffffffffffffffffffffffffffffffffffffffff9182166000908152600a6020908152604080832093909416825291909152205490565b60015474010000000000000000000000000000000000000000900460ff1615613d1a57604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b88613d2481614371565b15613d7a576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162826025913960400191505060405180910390fd5b88613d8481614371565b15613dda576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162826025913960400191505060405180910390fd5b613deb8b8b8b8b8b8b8b8b8b6153c1565b5050505050505050505050565b6007805460408051602060026001851615610100027fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0190941693909304601f810184900484028201840190925281815292918301828280156113bf5780601f10611394576101008083540402835291602001916113bf565b73ffffffffffffffffffffffffffffffffffffffff919091166000908152601060209081526040808320938352929052205460ff1690565b60015474010000000000000000000000000000000000000000900460ff1615613f3357604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b88613f3d81614371565b15613f93576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162826025913960400191505060405180910390fd5b88613f9d81614371565b15613ff3576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162826025913960400191505060405180910390fd5b613deb8b8b8b8b8b8b8b8b8b615405565b60005473ffffffffffffffffffffffffffffffffffffffff16331461408a57604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820181905260248201527f4f776e61626c653a2063616c6c6572206973206e6f7420746865206f776e6572604482015290519081900360640190fd5b73ffffffffffffffffffffffffffffffffffffffff81166140f6576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401808060200182810382526026815260200180615e6a6026913960400191505060405180910390fd5b6000546040805173ffffffffffffffffffffffffffffffffffffffff9283168152918316602083015280517f8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e09281900390910190a161415481614636565b50565b60025473ffffffffffffffffffffffffffffffffffffffff1633146141c7576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602c815260200180615fa2602c913960400191505060405180910390fd5b6141d08161462b565b60405173ffffffffffffffffffffffffffffffffffffffff8216907fffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b85590600090a250565b6000612bde82614371565b73ffffffffffffffffffffffffffffffffffffffff831661428b576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602481526020018061615c6024913960400191505060405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff82166142f7576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401808060200182810382526022815260200180615e906022913960400191505060405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff8084166000818152600a6020908152604080832094871680845294825291829020859055815185815291517f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b9259281900390910190a3505050565b614154816000615449565b73ffffffffffffffffffffffffffffffffffffffff1660009081526009602052604090205460ff1c60011490565b73ffffffffffffffffffffffffffffffffffffffff831661440b576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806161376025913960400191505060405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff8216614477576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401808060200182810382526023815260200180615da86023913960400191505060405180910390fd5b614480836145e1565b8111156144d8576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401808060200182810382526026815260200180615f536026913960400191505060405180910390fd5b6144ef836122c3836144e9876145e1565b9061456a565b614500826122c3836122bd866145e1565b8173ffffffffffffffffffffffffffffffffffffffff168373ffffffffffffffffffffffffffffffffffffffff167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef836040518082815260200191505060405180910390a3505050565b6000828211156145db57604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601e60248201527f536166654d6174683a207375627472616374696f6e206f766572666c6f770000604482015290519081900360640190fd5b50900390565b73ffffffffffffffffffffffffffffffffffffffff166000908152600960205260409020547f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff1690565b614154816001615449565b600080547fffffffffffffffffffffffff00000000000000000000000000000000000000001673ffffffffffffffffffffffffffffffffffffffff92909216919091179055565b6004805460408051602060026001851615610100027fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0190941693909304601f8101849004840282018401909252818152600093611e3d939192909183018282801561472a5780601f106146ff5761010080835404028352916020019161472a565b820191906000526020600020905b81548152906001019060200180831161470d57829003601f168201915b50505050506040518060400160405280600181526020017f320000000000000000000000000000000000000000000000000000000000000081525061476d6154d2565b6154d6565b73ffffffffffffffffffffffffffffffffffffffff8084166000908152600a6020908152604080832093861683529290522054612ff090849084906147b790856147bc565b61421f565b60008282018381101561483057604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601b60248201527f536166654d6174683a206164646974696f6e206f766572666c6f770000000000604482015290519081900360640190fd5b9392505050565b7f7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8111156148b0576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602a815260200180615fce602a913960400191505060405180910390fd5b6148b982614371565b1561490f576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401808060200182810382526025815260200180615f056025913960400191505060405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff909116600090815260096020526040902055565b612bab8585848487604051602001808481526020018381526020018260ff1660f81b815260010193505050506040516020818303038152906040526151c1565b60015474010000000000000000000000000000000000000000900460ff1615614a0257604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601060248201527f5061757361626c653a2070617573656400000000000000000000000000000000604482015290519081900360640190fd5b336000908152600c602052604090205460ff16614a6a576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602181526020018061601e6021913960400191505060405180910390fd5b81614a7481614371565b15614aca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162826025913960400191505060405180910390fd5b6000614ad5846145e1565b905060008311614b30576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401808060200182810382526029815260200180615e1e6029913960400191505060405180910390fd5b82811015614b89576040517f08c379a0000000000000000000000000000000000000000000000000000000008152600401808060200182810382526026815260200180615ff86026913960400191505060405180910390fd5b600b80548490039055614b9e84848303614837565b60408051848152905173ffffffffffffffffffffffffffffffffffffffff8616917fcc16f5dbb4873280815c1ee09dbd06736cffcc184412cf7a71a0fdb75d397ca5919081900360200190a260408051848152905160009173ffffffffffffffffffffffffffffffffffffffff8716917fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef9181900360200190a350505050565b73ffffffffffffffffffffffffffffffffffffffff86163314614cac576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806160e86025913960400191505060405180910390fd5b614cb88783868661554a565b604080517fd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de860208083019190915273ffffffffffffffffffffffffffffffffffffffff808b1683850152891660608301526080820188905260a0820187905260c0820186905260e0808301869052835180840390910181526101009092019092528051910120614d4a9088908361560a565b614d548783615788565b613b4287878761439f565b7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff821480614d8d5750428210155b614df857604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601e60248201527f46696174546f6b656e56323a207065726d697420697320657870697265640000604482015290519081900360640190fd5b6000614ea0614e0561467d565b73ffffffffffffffffffffffffffffffffffffffff80891660008181526011602090815260409182902080546001810190915582517f6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c98184015280840194909452938b166060840152608083018a905260a083019390935260c08083018990528151808403909101815260e09092019052805191012061580d565b905073__$715109b5d747ea58b675c6ea3f0dba8c60$__636ccea6528783856040518463ffffffff1660e01b8152600401808473ffffffffffffffffffffffffffffffffffffffff16815260200183815260200180602001828103825283818151815260200191508051906020019080838360005b83811015614f2d578181015183820152602001614f15565b50505050905090810190601f168015614f5a5780820380516001836020036101000a031916815260200191505b5094505050505060206040518083038186803b158015614f7957600080fd5b505af4158015614f8d573d6000803e3d6000fd5b505050506040513d6020811015614fa357600080fd5b505161501057604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601a60248201527f454950323631323a20696e76616c6964207369676e6174757265000000000000604482015290519081900360640190fd5b61501b86868661421f565b505050505050565b73ffffffffffffffffffffffffffffffffffffffff81166000818152600c6020908152604080832080547fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00166001179055600d8252918290207fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff90819055825181815292519093927f46980fca912ef9bcdbd36877427b6b90e860769f604e89c0e67720cece530d2092908290030190a25050565b612ff083836147b7846040518060600160405280602581526020016162cc6025913973ffffffffffffffffffffffffffffffffffffffff808a166000908152600a60209081526040808320938c16835292905220549190615847565b6040805173ffffffffffffffffffffffffffffffffffffffff8416602482015260448082018490528251808303909101815260649091019091526020810180517bffffffffffffffffffffffffffffffffffffffffffffffffffffffff167fa9059cbb00000000000000000000000000000000000000000000000000000000179052612ff09084906158f8565b6151cb83836159d0565b615245837f158b0a9edf7a828aad02f63cd515c68ef2f50ba807396f6d12842833a159742960001b8585604051602001808481526020018373ffffffffffffffffffffffffffffffffffffffff1681526020018281526020019350505050604051602081830303815290604052805190602001208361560a565b73ffffffffffffffffffffffffffffffffffffffff8316600081815260106020908152604080832086845290915280822080547fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00166001179055518492917f1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d8191a3505050565b6152d78783868661554a565b604080517f7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a226760208083019190915273ffffffffffffffffffffffffffffffffffffffff808b1683850152891660608301526080820188905260a0820187905260c0820186905260e0808301869052835180840390910181526101009092019092528051910120614d4a9088908361560a565b613b4287878787868689604051602001808481526020018381526020018260ff1660f81b81526001019350505050604051602081830303815290604052614d5f565b6000466153b98484836154d6565b949350505050565b612f1289898989898988888b604051602001808481526020018381526020018260ff1660f81b815260010193505050506040516020818303038152906040526152cb565b612f1289898989898988888b604051602001808481526020018381526020018260ff1660f81b81526001019350505050604051602081830303815290604052614c3e565b8061545c57615457826145e1565b6154a5565b73ffffffffffffffffffffffffffffffffffffffff82166000908152600960205260409020547f8000000000000000000000000000000000000000000000000000000000000000175b73ffffffffffffffffffffffffffffffffffffffff90921660009081526009602052604090209190915550565b4690565b8251602093840120825192840192909220604080517f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f8187015280820194909452606084019190915260808301919091523060a0808401919091528151808403909101815260c09092019052805191012090565b8142116155a2576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602b815260200180615df3602b913960400191505060405180910390fd5b8042106155fa576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260258152602001806162a76025913960400191505060405180910390fd5b61560484846159d0565b50505050565b73__$715109b5d747ea58b675c6ea3f0dba8c60$__636ccea6528461563661563061467d565b8661580d565b846040518463ffffffff1660e01b8152600401808473ffffffffffffffffffffffffffffffffffffffff16815260200183815260200180602001828103825283818151815260200191508051906020019080838360005b838110156156a557818101518382015260200161568d565b50505050905090810190601f1680156156d25780820380516001836020036101000a031916815260200191505b5094505050505060206040518083038186803b1580156156f157600080fd5b505af4158015615705573d6000803e3d6000fd5b505050506040513d602081101561571b57600080fd5b5051612ff057604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601e60248201527f46696174546f6b656e56323a20696e76616c6964207369676e61747572650000604482015290519081900360640190fd5b73ffffffffffffffffffffffffffffffffffffffff8216600081815260106020908152604080832085845290915280822080547fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00166001179055518392917f98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a591a35050565b6040517f19010000000000000000000000000000000000000000000000000000000000008152600281019290925260228201526042902090565b600081848411156158f0576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825283818151815260200191508051906020019080838360005b838110156158b557818101518382015260200161589d565b50505050905090810190601f1680156158e25780820380516001836020036101000a031916815260200191505b509250505060405180910390fd5b505050900390565b606061595a826040518060400160405280602081526020017f5361666545524332303a206c6f772d6c6576656c2063616c6c206661696c65648152508573ffffffffffffffffffffffffffffffffffffffff16615a5a9092919063ffffffff16565b805190915015612ff05780806020019051602081101561597957600080fd5b5051612ff0576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602a8152602001806161d0602a913960400191505060405180910390fd5b73ffffffffffffffffffffffffffffffffffffffff8216600090815260106020908152604080832084845290915290205460ff1615612c8f576040517f08c379a000000000000000000000000000000000000000000000000000000000815260040180806020018281038252602e815260200180616222602e913960400191505060405180910390fd5b60606153b9848460008585615a6e85615bc5565b615ad957604080517f08c379a000000000000000000000000000000000000000000000000000000000815260206004820152601d60248201527f416464726573733a2063616c6c20746f206e6f6e2d636f6e7472616374000000604482015290519081900360640190fd5b600060608673ffffffffffffffffffffffffffffffffffffffff1685876040518082805190602001908083835b60208310615b4357805182527fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe09092019160209182019101615b06565b6001836020036101000a03801982511681845116808217855250505050505090500191505060006040518083038185875af1925050503d8060008114615ba5576040519150601f19603f3d011682016040523d82523d6000602084013e615baa565b606091505b5091509150615bba828286615bcb565b979650505050505050565b3b151590565b60608315615bda575081614830565b825115615bea5782518084602001fd5b6040517f08c379a00000000000000000000000000000000000000000000000000000000081526020600482018181528451602484015284518593919283926044019190850190808383600083156158b557818101518382015260200161589d565b828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f10615c8c57805160ff1916838001178555615cb9565b82800160010185558215615cb9579182015b82811115615cb9578251825591602001919060010190615c9e565b50615cc5929150615d55565b5090565b828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f10615d28578280017fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00823516178555615cb9565b82800160010185558215615cb9579182015b82811115615cb9578235825591602001919060010190615d3a565b5b80821115615cc55760008155600101615d5656fe46696174546f6b656e56325f323a20426c61636b6c697374696e672070726576696f75736c7920756e626c61636b6c6973746564206163636f756e742145524332303a207472616e7366657220746f20746865207a65726f20616464726573735061757361626c653a206e65772070617573657220697320746865207a65726f206164647265737346696174546f6b656e56323a20617574686f72697a6174696f6e206973206e6f74207965742076616c696446696174546f6b656e3a206275726e20616d6f756e74206e6f742067726561746572207468616e203046696174546f6b656e3a206d696e7420746f20746865207a65726f20616464726573734f776e61626c653a206e6577206f776e657220697320746865207a65726f206164647265737345524332303a20617070726f766520746f20746865207a65726f206164647265737346696174546f6b656e3a206e65772070617573657220697320746865207a65726f2061646472657373526573637561626c653a206e6577207265736375657220697320746865207a65726f206164647265737346696174546f6b656e56325f323a204163636f756e7420697320626c61636b6c697374656446696174546f6b656e3a206d696e7420616d6f756e74206e6f742067726561746572207468616e203045524332303a207472616e7366657220616d6f756e7420657863656564732062616c616e636546696174546f6b656e3a2063616c6c6572206973206e6f7420746865206d61737465724d696e746572426c61636b6c69737461626c653a2063616c6c6572206973206e6f742074686520626c61636b6c697374657246696174546f6b656e56325f323a2042616c616e636520657863656564732028325e323535202d20312946696174546f6b656e3a206275726e20616d6f756e7420657863656564732062616c616e636546696174546f6b656e3a2063616c6c6572206973206e6f742061206d696e74657246696174546f6b656e3a206e6577206d61737465724d696e74657220697320746865207a65726f2061646472657373526573637561626c653a2063616c6c6572206973206e6f7420746865207265736375657245524332303a207472616e7366657220616d6f756e74206578636565647320616c6c6f77616e636546696174546f6b656e3a206e657720626c61636b6c697374657220697320746865207a65726f206164647265737346696174546f6b656e56323a2063616c6c6572206d7573742062652074686520706179656546696174546f6b656e3a20636f6e747261637420697320616c726561647920696e697469616c697a656445524332303a207472616e736665722066726f6d20746865207a65726f206164647265737345524332303a20617070726f76652066726f6d20746865207a65726f206164647265737346696174546f6b656e3a206d696e7420616d6f756e742065786365656473206d696e746572416c6c6f77616e63655061757361626c653a2063616c6c6572206973206e6f7420746865207061757365725361666545524332303a204552433230206f7065726174696f6e20646964206e6f74207375636365656446696174546f6b656e3a206e6577206f776e657220697320746865207a65726f206164647265737346696174546f6b656e56323a20617574686f72697a6174696f6e2069732075736564206f722063616e63656c6564426c61636b6c69737461626c653a206e657720626c61636b6c697374657220697320746865207a65726f2061646472657373426c61636b6c69737461626c653a206163636f756e7420697320626c61636b6c697374656446696174546f6b656e56323a20617574686f72697a6174696f6e206973206578706972656445524332303a2064656372656173656420616c6c6f77616e63652062656c6f77207a65726fa26469706673582212205b9c28831ca019c704546ef047ba19de251c8493a622e0f4ae1dff3520aaae2464736f6c634300060c0033'
  const placeholder = '__$715109b5d747ea58b675c6ea3f0dba8c60$__'
  const bridgedUsdcLogicBytecode = bytecodeWithPlaceholder
    .split(placeholder)
    .join(sigCheckerLib.address.replace(/^0x/, ''))

  // deploy bridged usdc logic
  const bridgedUsdcLogicFactory = new ethers.ContractFactory(
    [],
    bridgedUsdcLogicBytecode,
    deployer
  )
  const bridgedUsdcLogic = await bridgedUsdcLogicFactory.deploy()

  return bridgedUsdcLogic
}
