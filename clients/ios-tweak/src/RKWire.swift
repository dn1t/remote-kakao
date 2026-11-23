import CryptoKit
import Foundation

/// Start of the HKDF labels of the keys. Changing it changes every key.
private let keyLabel = "rk wire v1"

/// The wire framing of the remote-kakao protocol, in Swift because CryptoKit is the only public AES-GCM on iOS.
/// It must produce the same bytes as `packages/core/src/seal.ts`.
@objc(RKWire)
public final class RKWire: NSObject {
  @objc public static let up: UInt8 = 0
  @objc public static let down: UInt8 = 1

  private static let versionPlain: UInt8 = 0x00
  private static let versionSealed: UInt8 = 0x01
  private static let saltLength = 16
  private static let counterLength = 8
  private static let tagLength = 16
  private static let keyLength = 32
  private static let infoUp = Data("\(keyLabel) up".utf8)
  private static let infoDown = Data("\(keyLabel) down".utf8)

  /// HKDF-SHA256 with the token as input, the session salt as salt and a label per direction.
  @objc public static func deriveKey(token: String, salt: Data, direction: UInt8) -> Data {
    let key = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: SymmetricKey(data: Data(token.utf8)),
      salt: salt,
      info: direction == up ? infoUp : infoDown,
      outputByteCount: keyLength)
    return key.withUnsafeBytes { Data($0) }
  }

  /// A frame without encryption (`auth: false`).
  @objc public static func plainFrame(json: Data, device: String, direction: UInt8) -> Data? {
    guard let header = header(version: versionPlain, direction: direction, device: device) else {
      return nil
    }
    return header + json
  }

  /// A frame sealed with AES-256-GCM. The header, salt and counter are authenticated.
  @objc public static func sealFrame(
    json: Data, device: String, direction: UInt8, salt: Data, counter: UInt64, key: Data
  ) -> Data? {
    guard salt.count == saltLength, key.count == keyLength,
      var aad = header(version: versionSealed, direction: direction, device: device)
    else { return nil }
    aad += salt
    aad += bytes(of: counter)

    guard let nonce = try? AES.GCM.Nonce(data: Data(count: 4) + bytes(of: counter)),
      let box = try? AES.GCM.seal(
        json, using: SymmetricKey(data: key), nonce: nonce, authenticating: aad)
    else { return nil }
    return aad + box.ciphertext + box.tag
  }

  /// The JSON inside a sealed frame, or nil if the frame is malformed, goes the other direction,
  /// or was not sealed with `key`.
  @objc public static func openSealedFrame(_ frame: Data, key: Data, direction: UInt8) -> Data? {
    let frame = Data(frame)  // indices start at 0
    guard frame.count >= 3, frame[0] == versionSealed, frame[1] == direction, key.count == keyLength
    else { return nil }
    let counterStart = 3 + Int(frame[2]) + saltLength
    let cipherStart = counterStart + counterLength
    guard frame.count >= cipherStart + tagLength else { return nil }

    let counter = frame[counterStart..<cipherStart].reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
    guard let nonce = try? AES.GCM.Nonce(data: Data(count: 4) + bytes(of: counter)),
      let box = try? AES.GCM.SealedBox(
        nonce: nonce,
        ciphertext: frame[cipherStart..<(frame.count - tagLength)],
        tag: frame[(frame.count - tagLength)...])
    else { return nil }
    return try? AES.GCM.open(
      box, using: SymmetricKey(data: key), authenticating: frame[..<cipherStart])
  }

  /// The JSON inside a plain frame, or nil.
  @objc public static func openPlainFrame(_ frame: Data, direction: UInt8) -> Data? {
    let frame = Data(frame)
    guard frame.count >= 3, frame[0] == versionPlain, frame[1] == direction else { return nil }
    let jsonStart = 3 + Int(frame[2])
    guard frame.count >= jsonStart else { return nil }
    return frame[jsonStart...]
  }

  private static func header(version: UInt8, direction: UInt8, device: String) -> Data? {
    let id = Data(device.utf8)
    guard id.count <= 255, direction <= 1 else { return nil }
    return Data([version, direction, UInt8(id.count)]) + id
  }

  /// Big-endian bytes of the counter.
  private static func bytes(of counter: UInt64) -> Data {
    Data((0..<counterLength).map { UInt8(truncatingIfNeeded: counter >> UInt64(8 * (counterLength - 1 - $0))) })
  }
}
