import "dotenv/config";
import {
  JsonRpcProvider,
  SigningKey,
  Wallet,
  computeAddress,
  parseEther,
} from 'ethers';
import {
  Address,
  Context,
  Id,
  Info,
  TransferableOutput,
  addTxSignatures,
  avm,
  evm,
  networkIDs,
  pvm,
  secp256k1,
  utils,
} from '@avalabs/avalanchejs';

import genesisJson from './genesis.json' with {type: 'json'};

const AvmApi = new avm.AVMApi(process.env.AVAX_PUBLIC_URL);
const EvmApi = new evm.EVMApi(process.env.AVAX_PUBLIC_URL);
const PvmApi = new pvm.PVMApi(process.env.AVAX_PUBLIC_URL);
const Provider = new JsonRpcProvider(
  process.env.AVAX_PUBLIC_URL + '/ext/bc/C/rpc',
);
const Ctx = await Context.getContextFromURI(process.env.AVAX_PUBLIC_URL);

function generatePChainWallet() {
  const privKey = secp256k1.randomPrivateKey();
  const pubKey = secp256k1.getPublicKey(privKey);
  const addrRaw = secp256k1.publicKeyBytesToAddress(pubKey);
  const addrEth = ethAddressFromKey(privKey);
  const addrOut = new Address(addrRaw);
  console.log(`PrivateKey: ${utils.bufferToHex(privKey)}`);
  console.log(`PublicKey:  ${utils.bufferToHex(pubKey)}`);
  console.log(`AddressRaw: ${utils.bufferToHex(addrRaw)}`);
  console.log(`AddressEth: ${addrEth}`);
  console.log(`Fuji:       ${addrOut.toString('fuji')}`);
  console.log(`Avax:       ${addrOut.toString('avax')}`);
}

function bech32AddressFromKey(privKeyBytes, hrp) {
  const pubKey = secp256k1.getPublicKey(privKeyBytes);
  const addrRaw = secp256k1.publicKeyBytesToAddress(pubKey);
  const addr = new Address(addrRaw);
  return addr.toString(hrp);
}

function ethAddressFromKey(privKeyBytes) {
  return computeAddress(new SigningKey(privKeyBytes));
}

async function waitForTx(txHash) {
  const timeoutMSec = 5000;
  const intervalMSec = 100;
  for (let i = 0; i < timeoutMSec; i += intervalMSec) {
    const txEvm = await EvmApi.getAtomicTxStatus(txHash);
    const txPvm = await PvmApi.getTxStatus({txID: txHash});
    if (txEvm.status == 'Accepted' || txPvm.status == 'Committed') {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMSec));
  }
  throw new Error("giving up waiting");
}

async function getUtxos(address, minAmount) {
  const {utxos} = await PvmApi.getUTXOs({addresses: [address]});
  utxos.sort((a, b) => {
    const diff = a.output.amount() - b.output.amount();
    return diff < 0 ? -1 : diff > 0 ? 1 : 0;
  });

  if (minAmount <= 0) {
    return [
      utxos,
      utxos.reduce((agg, x) => agg + x.output.amount(), 0n),
    ];
  }

  let totalAmount = 0n;
  let i = 0;
  for (; i < utxos.length && totalAmount < minAmount; ++i) {
    totalAmount += utxos[i].output.amount();
  }

  if (totalAmount < minAmount) {
    return [[], 0n];
  }

  return [utxos.slice(0, i), totalAmount];
}

async function transferCtoC(privKey, recipient) {
  const wallet = new Wallet(privKey, Provider);
  const tx = await wallet.sendTransaction({
    to: recipient,
    value: parseEther('1'),
  });
  await tx.wait();
  console.log(`${tx.hash} ${wallet.address} --> ${recipient}`);
}

async function transferCtoP(
  fromPrivKeyStr,
  toPrivKeyStr,
  amount,
) {
  const fromPrivKey = utils.hexToBuffer(fromPrivKeyStr);
  const fromAddr = ethAddressFromKey(fromPrivKey);
  const fromAddrBytes = utils.hexToBuffer(fromAddr);
  const toPrivKey = utils.hexToBuffer(toPrivKeyStr);
  const toAddr = 'P-' + bech32AddressFromKey(toPrivKey, Ctx.hrp);
  const toAddrBytes = utils.bech32ToBytes(toAddr);

  if (amount > 0n) {
    const txCount = await Provider.getTransactionCount(fromAddr);
    const baseFee = await EvmApi.getBaseFee();
    const txExp = evm.newExportTxFromBaseFee(
      Ctx,
      // Sometimes estimation is not accurate.  Multiply by 2 to have buffer.
      baseFee * 2n / BigInt(1e9),
      amount,
      Ctx.pBlockchainID,
      fromAddrBytes,
      [toAddrBytes],
      BigInt(txCount),
    );
    await addTxSignatures({
      unsignedTx: txExp,
      privateKeys: [fromPrivKey],
    });
    const txExpSigned = txExp.getSignedTx();
    const respExp = await EvmApi.issueSignedTx(txExpSigned);
    await waitForTx(respExp.txID);

    console.log(`${respExp.txID} ${fromAddr} -->`);
  }

  const {utxos} = await PvmApi.getUTXOs({
    sourceChain: 'C',
    addresses: [toAddr],
  });

  if (utxos.length == 0) {
    return;
  }

  const txImp = pvm.newImportTx(
    Ctx,
    Ctx.cBlockchainID,
    utxos,
    [toAddrBytes],
    [toAddrBytes],
  );
  await addTxSignatures({
    unsignedTx: txImp,
    privateKeys: [toPrivKey],
  });
  const txImpSigned = txImp.getSignedTx();
  const respImp = await PvmApi.issueSignedTx(txImpSigned);
  await waitForTx(respImp.txID);

  console.log(`${respImp.txID} --> ${toAddr}`);
}

async function transferPtoP(
  fromPrivKeyStr,
  toAddr,
  amount,
) {
  const fromPrivKey = utils.hexToBuffer(fromPrivKeyStr);
  const fromAddr = 'P-' + bech32AddressFromKey(fromPrivKey, Ctx.hrp);
  const fromAddrBytes = utils.bech32ToBytes(fromAddr);
  const toAddrBytes = utils.bech32ToBytes(toAddr);

  const [utxos, _] = await getUtxos(fromAddr, amount);
  const output = TransferableOutput.fromNative(
    Ctx.avaxAssetID,
    amount,
    [toAddrBytes],
  );
  const tx = pvm.newBaseTx(
    Ctx,
    [fromAddrBytes],
    utxos,
    [output],
  );
  await addTxSignatures({
    unsignedTx: tx,
    privateKeys: [fromPrivKey],
  });
  const txSigned = tx.getSignedTx();
  const resp = await PvmApi.issueSignedTx(txSigned);
  await waitForTx(resp.txID);

  console.log(`${resp.txID} ${fromAddr} --> ${toAddr}`);
}

async function stake(
  stake,
  stakePeriodInDays,
  nodeID,
  blsPublicKey,
  blsSignature,
  fromPrivKeyStr,
  outputAddr,
) {
  const fromPrivKey = utils.hexToBuffer(fromPrivKeyStr);
  const fromAddr = 'P-' + bech32AddressFromKey(fromPrivKey, Ctx.hrp);
  const fromAddrBytes = utils.bech32ToBytes(fromAddr);
  const outAddrBytes = utils.bech32ToBytes(outputAddr);

  const [utxos, _] = await getUtxos(fromAddr, stake);
  if (utxos.length == 0) {
    throw new Error("Insufficient funds");
  }

  const startTime = await new pvm.PVMApi().getTimestamp();
  const startDate = new Date(startTime.timestamp);
  const start = BigInt(startDate.getTime() / 1000);
  const endTime = new Date(startTime.timestamp);
  endTime.setDate(endTime.getDate() + stakePeriodInDays);
  const end = BigInt(endTime.getTime() / 1000);

  const networkId = networkIDs.PrimaryNetworkID.toString();
  const tx = pvm.newAddPermissionlessValidatorTx(
    Ctx,
    utxos,
    [fromAddrBytes],
    nodeID,
    networkId,
    start,
    end,
    stake,
    [outAddrBytes], // rewards
    [outAddrBytes], // delegatorRewards
    1e4 * 20,       // shares
    undefined,      // options
    1,              // threshold
    0n,             // locktime
    utils.hexToBuffer(blsPublicKey),
    utils.hexToBuffer(blsSignature),
  );
  await addTxSignatures({
    unsignedTx: tx,
    privateKeys: [fromPrivKey],
  });
  const txSigned = tx.getSignedTx();
  const resp = await PvmApi.issueSignedTx(txSigned);
  await waitForTx(resp.txID);
  console.log(resp.txID);
}

async function delegate(
  stake,
  stakePeriodInHours,
  nodeID,
  fromPrivKeyStr,
  outputAddr,
) {
  const fromPrivKey = utils.hexToBuffer(fromPrivKeyStr);
  const fromAddr = 'P-' + bech32AddressFromKey(fromPrivKey, Ctx.hrp);
  const fromAddrBytes = utils.bech32ToBytes(fromAddr);
  const outAddrBytes = utils.bech32ToBytes(outputAddr);

  const {utxos} = await PvmApi.getUTXOs({addresses: [fromAddr]});
  if (utxos.length == 0) {
    throw new Error("Insufficient funds");
  }

  const startTime = await new pvm.PVMApi().getTimestamp();
  const startDate = new Date(startTime.timestamp);
  const start = BigInt(startDate.getTime() / 1000);
  const end = start + BigInt(stakePeriodInHours * 3600);

  const networkId = networkIDs.PrimaryNetworkID.toString();
  const tx = pvm.newAddPermissionlessDelegatorTx(
    Ctx,
    utxos,
    [fromAddrBytes],
    nodeID,
    networkId,
    start,
    end,
    stake,
    [outAddrBytes], // rewards
    undefined,      // options
    1,              // threshold
    0n,             // locktime
  );
  await addTxSignatures({
    unsignedTx: tx,
    privateKeys: [fromPrivKey],
  });
  const txSigned = tx.getSignedTx();
  const resp = await PvmApi.issueSignedTx(txSigned);
  await waitForTx(resp.txID);
  console.log(resp.txID);
}

async function showHistory() {
  const respHeight = await PvmApi.getHeight();

  for (let i = 0; i <= respHeight.height; ++i) {
    const body =
      '{"id":1,"jsonrpc":"2.0","method":"platform.getBlockByHeight"'
      + `,"params":{"encoding":"json","height":${i}}}`;
    const resp = await fetch(
      process.env.AVAX_PUBLIC_URL + '/ext/bc/P', {
      method: 'POST',
      body,
      headers: {
        'Content-Type': 'application/json',
      },
    });
    const respJson = await resp.json();
    const txs = respJson.result.block?.txs;
    if (!txs) {
      continue;
    }
    for (let j = 0; j < txs.length; ++j) {
      console.log(`${i}.${j} ${txs[j].id}`);
    }
  }
}

async function createSubnet(
  fromPrivKeyStr,
  ownerAddrs,
) {
  const fromPrivKey = utils.hexToBuffer(fromPrivKeyStr);
  const fromAddr = 'P-' + bech32AddressFromKey(fromPrivKey, Ctx.hrp);
  const fromAddrBytes = utils.bech32ToBytes(fromAddr);

  ownerAddrs.sort();
  const ownerAddrsBytes = ownerAddrs.map(addr => utils.bech32ToBytes(addr));

  const {utxos} = await PvmApi.getUTXOs({addresses: [fromAddr]});
  if (utxos.length == 0) {
    throw new Error("Insufficient funds");
  }

  const tx = pvm.newCreateSubnetTx(
    Ctx,
    utxos,
    [fromAddrBytes],
    ownerAddrsBytes,
    undefined, // options
    1,
    0,
  );
  await addTxSignatures({
    unsignedTx: tx,
    privateKeys: [fromPrivKey],
  });
  const txSigned = tx.getSignedTx();
  const resp = await PvmApi.issueSignedTx(txSigned);
  await waitForTx(resp.txID);
  console.log(`SubnetID ${resp.txID}`);
  return resp.txID;
}

async function createChain(
  fromPrivKeyStr,
  subnetID,
  chainName,
  genesisData,
) {
  const fromPrivKey = utils.hexToBuffer(fromPrivKeyStr);
  const fromAddr = 'P-' + bech32AddressFromKey(fromPrivKey, Ctx.hrp);
  const fromAddrBytes = utils.bech32ToBytes(fromAddr);

  const chainNameBytes = new Uint8Array(32);
  chainNameBytes.set(new TextEncoder().encode(chainName), 0);
  const vmID = Id.fromBytes(chainNameBytes)[0].toString();

  const {utxos} = await PvmApi.getUTXOs({addresses: [fromAddr]});
  if (utxos.length == 0) {
    throw new Error("Insufficient funds");
  }

  const tx = pvm.newCreateBlockchainTx(
    Ctx,
    utxos,
    [fromAddrBytes],
    subnetID,
    chainName,
    vmID,
    [], // feature extensions
    genesisData,
    [0], // SubnetAuth
  );
  await addTxSignatures({
    unsignedTx: tx,
    privateKeys: [fromPrivKey],
  });
  tx.credentials[1] = tx.credentials[0]; // hack
  const txSigned = tx.getSignedTx();
  const resp = await PvmApi.issueSignedTx(txSigned);
  await waitForTx(resp.txID);
  console.log(`BlockchainID ${resp.txID}`);
}

async function addSubnetValidator(
  fromPrivKeyStr,
  nodeID,
  subnetID,
  stakePeriodInDays,
  stake,
) {
  const fromPrivKey = utils.hexToBuffer(fromPrivKeyStr);
  const fromAddr = 'P-' + bech32AddressFromKey(fromPrivKey, Ctx.hrp);
  const fromAddrBytes = utils.bech32ToBytes(fromAddr);

  const {utxos} = await PvmApi.getUTXOs({addresses: [fromAddr]});
  if (utxos.length == 0) {
    throw new Error("Insufficient funds");
  }

  const startTime = await new pvm.PVMApi().getTimestamp();
  const startDate = new Date(startTime.timestamp);
  const start = BigInt(startDate.getTime() / 1000);
  const endTime = new Date(startTime.timestamp);
  endTime.setDate(endTime.getDate() + stakePeriodInDays);
  const end = BigInt(endTime.getTime() / 1000);

  const tx = pvm.newAddSubnetValidatorTx(
    Ctx,
    utxos,
    [fromAddrBytes],
    nodeID,
    start,
    end,
    stake,
    subnetID,
    [0], // SubnetAuth
    null // SpendOptions
  );
  await addTxSignatures({
    unsignedTx: tx,
    privateKeys: [fromPrivKey],
  });
  tx.credentials[1] = tx.credentials[0]; // hack
  const txSigned = tx.getSignedTx();
  const resp = await PvmApi.issueSignedTx(txSigned);
  await waitForTx(resp.txID);
  console.log(`txHash ${resp.txID}`);
}

async function main() {
  await transferCtoC(
    process.env.C_PRIVATE_KEY,
    '0x553fd972cbb9b70406c8c29d5b2675d6577fdd03',
    BigInt(1 * 1e9),
  );
  await transferCtoP(
    process.env.C_PRIVATE_KEY,
    process.env.P_PRIVATE_KEY,
    BigInt(10000 * 1e9),
  );
  await transferPtoP(
    process.env.P_PRIVATE_KEY,
    'P-' + bech32AddressFromKey(utils.hexToBuffer(process.env.P_PRIVATE_KEY_DELE), Ctx.hrp),
    BigInt(1 * 1e9),
  );
  const subnetID = await createSubnet(
    process.env.P_PRIVATE_KEY,
    [
      'P-' + bech32AddressFromKey(utils.hexToBuffer(process.env.P_PRIVATE_KEY), Ctx.hrp),
    ]
  );
  await createChain(
    process.env.P_PRIVATE_KEY,
    subnetID,
    "Kinesis",
    genesisJson,
  );

  const info = new Info(process.env.AVAX_PUBLIC_URL);
  const nodeId = await info.getNodeId();

  await addSubnetValidator(
    process.env.P_PRIVATE_KEY,
    nodeId.nodeID,
    subnetID,
    7,
    100,
  );
  return;

  await showHistory();
  return;

  await stake(
    BigInt(2100 * 1e9),
    2,
    nodeId.nodeID,
    nodeId.nodePOP.publicKey,
    nodeId.nodePOP.proofOfPossession,
    process.env.P_PRIVATE_KEY,
    process.env.P_CHAIN_ADDRESS_REWARDS,
  );

  await delegate(
    BigInt(100 * 1e9),
    25,
    nodeId.nodeID,
    process.env.P_PRIVATE_KEY_DELE,
    process.env.P_CHAIN_ADDRESS_DEL_REWARDS,
  );
  return;

}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });