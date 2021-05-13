# Changelog

## [0.5.0](https://github.com/kinecosystem/kin-node/releases/tag/0.5.0)
- Remove Stellar (Kin 2 & Kin 3) support
    - Only Kin 4 and v4 Agora APIs are supported
    - Removed `accountClient`, `txClient`, `kinVersion`, `whitelistKey`, and `desiredKinVersion` from `ClientConfig`
    - Removed `channel` from `Payment` and `EarnBatch`
    - Removed `envelope` and `txHash()` from `SignTransactionRequest` 
    - Removed `envelope`, `signedEnvelope`, and `networkPassphrase` from `SignTransactionResponse`
    - Removed `kin_version`, `tx_hash`, and `stellar_event` from `Event.transaction_event`
- Add sender create support for `Client.submitPayment`
- Add `mergeTokenAccounts` to `Client`
- Add create account webhook support
- Add creation parsing to `SignTransactionRequest`
- `SignTransactionResponse.sign` now signs Solana transactions
- Rename `SignTransactionRequest.solanaTransaction` to `SignTransactionRequest.transaction` 

## [0.4.0](https://github.com/kinecosystem/kin-node/releases/tag/0.4.0)
- Expose `requestAirdrop` on `Client` for Kin 4

## [0.3.11](https://github.com/kinecosystem/kin-node/releases/tag/0.3.11)
- Add AccountExists to the default non-retriable error list. This should the decrease
  latencies in situations where a Resolve() is required by about 8 seconds (with the
  default retry configuration)
- Fix Solana create account error crash

## [0.3.10](https://github.com/kinecosystem/kin-node/releases/tag/0.3.10)
- Add `dedupeId` support on payments (`Client.submitPayment`) and earn batches (`Client.submitEarnBatch`)
- `Client.submitEarnBatch` now supports submitting only a single transaction and up to 15 earns
- `EarnBatchResult` is now an interface with `txId`, `txError` and `earnErrors`

## [0.3.9](https://github.com/kinecosystem/kin-node/releases/tag/0.3.9)
- Add `PaymentErrors` on `TransactionErrors`
- Fix parsing transaction error in `Client.submitPayment`

## [0.3.8](https://github.com/kinecosystem/kin-node/releases/tag/0.3.8)
- Set operation errors on `TransactionErrors`

## [0.3.7](https://github.com/kinecosystem/kin-node/releases/tag/0.3.7)
- Fix client error handling

## [0.3.6](https://github.com/kinecosystem/kin-node/releases/tag/0.3.6)
- Add optional `accountResolution` parameter to `Client.getBalance`

## [0.3.5](https://github.com/kinecosystem/kin-node/releases/tag/0.3.5)
- Create new accounts with different token account address

## [0.3.4](https://github.com/kinecosystem/kin-node/releases/tag/0.3.4)
- Do not reject Kin 4 payments with channel set
- Check for duplicate signers for Stellar transactions

## [0.3.3](https://github.com/kinecosystem/kin-node/releases/tag/0.3.3)
- Call v3 `GetTransaction` API for Kin 2 & 3

## [0.3.2](https://github.com/kinecosystem/kin-node/releases/tag/0.3.2)
- Fixed invoice count check bug

## [0.3.1](https://github.com/kinecosystem/kin-node/releases/tag/0.3.1)
- Fixed uploaded package

## [0.3.0](https://github.com/kinecosystem/kin-node/releases/tag/0.3.0)
- Add Kin 4 support
- Rename `txHash` to `txId` in `Client.getTransaction`, `TransactionData` and `EarnResult`
- Add `defaultCommitment` to `ClientConfig`
- Add optional `commitment` parameter to `Client` methods (`createAccount`, `getBalance`, `getTransaction`, `submitPayment`, `submitEarnBatch`)
- Add optional `subsidizer` parameter to `Client.createAcount`, `Payment`, and `EarnBatch`
- Add optional `senderResolution` and `destinationResolution` parameters to `Client.submitPayment` and `Client.submitEarnBatch`
- Mark `tx_hash` property in `Event` as deprecated.
- Mark `SignTransactionRequest.txHash()` as deprecated in favour of `SignTransactionRequest.txId()`.

## [0.2.3](https://github.com/kinecosystem/kin-node/releases/tag/0.2.3)
- Add Kin 2 support

## [0.2.2](https://github.com/kinecosystem/kin-node/releases/tag/0.2.2)
- Update API version

## [0.2.1](https://github.com/kinecosystem/kin-node/releases/tag/0.2.1)
- Add user-agent metadata to Agora requests

## [0.2.0](https://github.com/kinecosystem/kin-node/releases/tag/0.2.0)
- Rename `source` in `Payment` and `EarnBatch` to `channel` for clarity
- Adjust `BadNonceError` handling

## [0.1.2](https://github.com/kinecosystem/kin-node/releases/tag/0.1.2)
- Add a `NONE` transaction type

## [0.1.1](https://github.com/kinecosystem/kin-node/releases/tag/0.1.1)
- Update installation commands

## [0.1.0](https://github.com/kinecosystem/kin-node/releases/tag/0.1.0)
- Initial release with Kin 3 support
