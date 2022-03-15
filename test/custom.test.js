const hre = require('hardhat')
const { ethers, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { utils } = ethers

const Utxo = require('../src/utxo')
const { transaction, registerAndTransact, prepareTransaction, buildMerkleTree } = require('../src/index')
const { toFixedHex, poseidonHash } = require('../src/utils')
const { Keypair } = require('../src/keypair')
const { encodeDataForBridge } = require('./utils')

const MERKLE_TREE_HEIGHT = 5
const l1ChainId = 1
const MINIMUM_WITHDRAWAL_AMOUNT = utils.parseEther(process.env.MINIMUM_WITHDRAWAL_AMOUNT || '0.05')
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther(process.env.MAXIMUM_DEPOSIT_AMOUNT || '1')

describe('TornadoPool', function () {
  this.timeout(20000)

  async function deploy(contractName, ...args) {
    const Factory = await ethers.getContractFactory(contractName)
    const instance = await Factory.deploy(...args)
    return instance.deployed()
  }

  async function mtfixture() {
    require('../scripts/compileHasher')
    const hasher = await deploy('Hasher')
    const merkleTreeWithHistory = await deploy(
      'MerkleTreeWithHistoryMock',
      MERKLE_TREE_HEIGHT,
      hasher.address,
    )
    await merkleTreeWithHistory.initialize()
    return { hasher, merkleTreeWithHistory }
  }

  async function fixture() {
    require('../scripts/compileHasher')
    const [sender, gov, l1Unwrapper, multisig] = await ethers.getSigners()
    const verifier2 = await deploy('Verifier2')
    const verifier16 = await deploy('Verifier16')
    const hasher = await deploy('Hasher')

    const token = await deploy('PermittableToken', 'Wrapped ETH', 'WETH', 18, l1ChainId)
    await token.mint(sender.address, utils.parseEther('10000'))

    const amb = await deploy('MockAMB', gov.address, l1ChainId)
    const omniBridge = await deploy('MockOmniBridge', amb.address)

    /** @type {TornadoPool} */
    const tornadoPoolImpl = await deploy(
      'TornadoPool',
      verifier2.address,
      verifier16.address,
      MERKLE_TREE_HEIGHT,
      hasher.address,
      token.address,
      omniBridge.address,
      l1Unwrapper.address,
      gov.address,
      l1ChainId,
      multisig.address,
    )

    const { data } = await tornadoPoolImpl.populateTransaction.initialize(
      MINIMUM_WITHDRAWAL_AMOUNT,
      MAXIMUM_DEPOSIT_AMOUNT,
    )
    const proxy = await deploy(
      'CrossChainUpgradeableProxy',
      tornadoPoolImpl.address,
      gov.address,
      data,
      amb.address,
      l1ChainId,
    )

    const tornadoPool = tornadoPoolImpl.attach(proxy.address)

    await token.approve(tornadoPool.address, utils.parseEther('10000'))

    return { tornadoPool, token, proxy, omniBridge, amb, gov, multisig }
  }


  it('should deposit, withdraw, and assert', async function () {

    //////////////////////////////////////////
    // Gas estimate to insert into Merkle Tree
    //////////////////////////////////////////
    const { merkleTreeWithHistory } = await loadFixture(mtfixture)
    const gas = await merkleTreeWithHistory.estimateGas.hashLeftRight(toFixedHex(123), toFixedHex(456))
    console.log('************************************************')
    console.log('*** Insert into Merkle Tree gas estimate: ', gas - 21000)
    console.log('************************************************')

    //////////////////////////////////////////
    // Alice deposits into tornado pool
    //////////////////////////////////////////

    const { tornadoPool, token, omniBridge } = await loadFixture(fixture)

    console.log('********************************************************************')
    const ethFactor = (10**18)

    const recipient = '0xDeaD00000000000000000000000000000000BEEf'
    let poolBalance1 = await token.balanceOf(tornadoPool.address)
    let recipientBalance1 = await token.balanceOf(recipient)
    let omniBridgeBalance1 = await token.balanceOf(omniBridge.address)

    console.log('*** Initial L1 balance is: ', recipientBalance1.toString())
    console.log('*** Initial Omnibridge balance is: ', omniBridgeBalance1.toString())
    console.log('*** Initial Tornado Pool amount: ', poolBalance1.toString())

  
    const aliceKeypair = new Keypair() // contains private and public keys

    // Alice deposits into tornado pool
    const aliceDepositAmount = utils.parseEther('0.08')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair: aliceKeypair })
    const { args, extData } = await prepareTransaction({
      tornadoPool,
      outputs: [aliceDepositUtxo],
    })

    console.log('********************************************************************')
    console.log('*** Alice deposit amount ETH: ', (aliceDepositUtxo.amount)/ethFactor)
    console.log('********************************************************************')

    // const poolBalance2 = await token.balanceOf(tornadoPool.address)
    // console.log('*** Pool after deposit .08 ETH: ', poolBalance.toString())

    const onTokenBridgedData = encodeDataForBridge({
      proof: args,
      extData,
    })

    const onTokenBridgedTx = await tornadoPool.populateTransaction.onTokenBridged(
      token.address,
      aliceDepositUtxo.amount,
      onTokenBridgedData,
    )
    // emulating bridge. first it sends tokens to omnibridge mock then it sends to the pool
    await token.transfer(omniBridge.address, aliceDepositAmount)

    poolBalance1 = await token.balanceOf(tornadoPool.address)
    recipientBalance1 = await token.balanceOf(recipient)
    omniBridgeBalance1 = await token.balanceOf(omniBridge.address)

    console.log('********************************************************************')
    console.log('*** After transfer to bridge, L1 ETH balance is: ', recipientBalance1/ethFactor)
    console.log('*** After transfer to bridge, Omnibridge ETH balance is: ', omniBridgeBalance1/ethFactor)
    console.log('*** After transfer to bridge, Tornado Pool ETH balance: ', poolBalance1/ethFactor)
    console.log('********************************************************************')

    const transferTx = await token.populateTransaction.transfer(tornadoPool.address, aliceDepositAmount)

    await omniBridge.execute([
      { who: token.address, callData: transferTx.data }, // send tokens to pool
      { who: tornadoPool.address, callData: onTokenBridgedTx.data }, // call onTokenBridgedTx
    ])

    poolBalance1 = await token.balanceOf(tornadoPool.address)
    recipientBalance1 = await token.balanceOf(recipient)
    omniBridgeBalance1 = await token.balanceOf(omniBridge.address)

    console.log('********************************************************************')
    console.log('*** After bridge to pool transfer, L1 ETH balance is: ', recipientBalance1/ethFactor)
    console.log('*** After bridge to pool transfer, Omnibridge ETH balance is: ', omniBridgeBalance1/ethFactor)
    console.log('*** After bridge to pool transfer, Tornado Pool ETH balance: ', poolBalance1/ethFactor)
    console.log('********************************************************************')

    const aliceWithdrawAmount = utils.parseEther('0.05')
    console.log('********************************************************************')
    console.log('*** Withdrawing from pool ETH amount: ', aliceWithdrawAmount/ethFactor)
    console.log('********************************************************************')
    // withdraws a part of his funds from the shielded pool
    const aliceChangeUtxo = new Utxo({
      amount: aliceDepositAmount.sub(aliceWithdrawAmount),
      keypair: aliceKeypair,
    })
    await transaction({
      tornadoPool,
      inputs: [aliceDepositUtxo],
      outputs: [aliceChangeUtxo],
      recipient: recipient,
      isL1Withdrawal: true,
    })

    poolBalance1 = await token.balanceOf(tornadoPool.address)
    recipientBalance1 = await token.balanceOf(recipient)
    omniBridgeBalance1 = await token.balanceOf(omniBridge.address)

    console.log('********************************************************************')
    console.log('*** After withdrawal, L1 ETH balance is: ', recipientBalance1/ethFactor)
    console.log('*** After withdrawal, Omnibridge ETH balance is: ', omniBridgeBalance1/ethFactor)
    console.log('*** After withdrawal, Tornado Pool ETH balance: ', poolBalance1/ethFactor)
    console.log('********************************************************************')

    console.log('********************************************************************')
    console.log('*** Checking L1 ETH balance, expected to be 0')
    const recipientBalance = await token.balanceOf(recipient)
    expect(recipientBalance.toString()).to.be.equal('0')
    console.log('*** L1 ETH balance is: ', recipientBalance/ethFactor)

    console.log('********************************************************************')
    console.log('*** Checking Omnibridge token balance = withdrawal amount')
    const omniBridgeBalance = await token.balanceOf(omniBridge.address)
    expect(omniBridgeBalance.toString()).to.be.equal(aliceWithdrawAmount.toString())
    console.log('*** Onmibridge ETH balance is: ', omniBridgeBalance/ethFactor)
    console.log('*** Withdrawal amount ETH: ', aliceWithdrawAmount/ethFactor)

    console.log('********************************************************************')
    console.log('*** Checking Tornado Pool ETH balance = (deposit - withdrawal)')
    const poolBalance = await token.balanceOf(tornadoPool.address)
    expect(poolBalance).to.be.equal(aliceDepositUtxo.amount.sub(aliceWithdrawAmount))
    console.log('*** Tornado Pool ETH balance: ', poolBalance/ethFactor)
    console.log('*** Deposit amount ETH: ', (aliceDepositUtxo.amount)/ethFactor)
    console.log('*** Withdrawal amount ETH: ', aliceWithdrawAmount/ethFactor)
    console.log('********************************************************************')
    

  })
 
})
