# Changelog

## Unreleased

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
