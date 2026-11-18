> [!WARNING]
> remote-kakao is under heavy development. APIs may change without notice, and documentation and
> installation guides are not available yet.

# remote-kakao

Build KakaoTalk bots in Node.js. remote-kakao relays messages between KakaoTalk and your app, so you can receive and reply to them with a familiar event-driven API.

## Features (Planned)

- **Multiple Transports**: Pick the protocol that suits your environment.
- **Cross-platform Clients**: Run your bot on Android or Apple devices and drive it from the same Node.js code.
- **Event-Driven**: Built on Node.js' event model for a familiar and rapid development experience.

## Support

| Transport          | Status         |
| ------------------ | -------------- |
| TCP                | 🚧 In Progress |
| UDP                | 📋 Planned     |
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
pnpm install   # install dependencies and set up git hooks
pnpm lint      # lint with oxlint
pnpm fmt       # format with oxfmt
```

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) with the [`@commitlint/config-conventional` rules](https://github.com/conventional-changelog/commitlint/tree/master/%40commitlint/config-conventional#rules). They are checked by commitlint on every commit.

## License

[LGPL-3.0-or-later](LICENSE)
