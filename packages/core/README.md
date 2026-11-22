> [!NOTE]
> This branch (`next`) contains the upcoming major version of remote-kakao, which has not been
> released yet. The version currently published to npm can be found on the
> [`v2`](https://github.com/remote-kakao/core/tree/v2) branch.

> [!WARNING]
> remote-kakao is under heavy development. APIs may change without notice, and documentation and
> installation guides are not available yet.

# remote-kakao

remote-kakao bridges Node.js and KakaoTalk running on your devices. A client runs alongside or inside the KakaoTalk app and relays messages to and from your Node.js app, which uses the same API whichever platform and transport you choose.

## Features (Planned)

- **Multiple Clients**: Connect devices running iOS, Android, macOS or Windows. Each device reports what it can do, and calls it can't handle fail before anything is sent.
- **Multiple Transports**: Pick the transport that suits your network. Your code stays the same whichever you choose.
- **Reliable Delivery**: Messages that arrive while your app is offline wait on the device and are delivered when it reconnects, flagged so you can tell them apart.
- **Encrypted by Default**: All traffic is encrypted and authenticated with a token shared by your app and your devices.
- **Event-Driven**: Built on Node.js' event model for a familiar and rapid development experience.

## Support

| Transport          | Status         |
| ------------------ | -------------- |
| UDP                | 🚧 In Progress |
| TCP                | 📋 Planned     |
| WebSocket          | 📋 Planned     |
| Server-Sent Events | 📋 Planned     |

| Client                       | Status         |
| ---------------------------- | -------------- |
| iOS                          | 🚧 In Progress |
| Android (via MessengerBot R) | 📋 Planned     |
| Android (standalone)         | 📋 Planned     |
| macOS                        | 📋 Planned     |
| Windows                      | 📋 Planned     |

## Development

```sh
pnpm install     # install dependencies and set up git hooks
pnpm lint        # lint with oxlint
pnpm fmt         # format with oxfmt
pnpm test:core   # run core tests
```

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) with the [`@commitlint/config-conventional` rules](https://github.com/conventional-changelog/commitlint/tree/master/%40commitlint/config-conventional#rules). They are checked by commitlint on every commit.

## License

[LGPL-3.0-or-later](LICENSE)
