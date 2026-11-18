#!/usr/bin/env node
//
// Injects tweaks into a decrypted IPA and signs it for sideloading.
// Only works on macOS with Xcode Command-line tools
// and cyan (https://github.com/asdfzxcvbn/pyzule-rw) installed.
//
// Usage:
//  1. Put these in the .local directory at the repository root
//     If there are multiple matches, the first by name is used:
//     - the decrypted IPA (KakaoTalk*.ipa or com.iwilab.KakaoTalk*.ipa)
//     - the provisioning profile to sign with (*.mobileprovision)
//  2. Import the profile's certificate into the login keychain:
//     $ security import '<p12-name>.p12' -k ~/Library/Keychains/login.keychain-db -P '<p12-password>' -T /usr/bin/codesign
//  3. $ pnpm run sideload [-i|--install] [--bundle-id <id>]
//
// Notes:
// - The signed IPA is written to .local/KakaoTalk-tweaked.ipa.
// - --bundle-id replaces CFBundleIdentifier, which breaks push notifications.
// - --install installs the IPA on a connected device.
//   Only works with ideviceinstaller (https://github.com/libimobiledevice/ideviceinstaller) installed.
//

import { spawnSync } from "node:child_process";
import { hash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs, styleText } from "node:util";

const INPUT_DIR = ".local";
const TWEAKS: readonly string[] = [];

class SideloadError extends Error {}

function die(message: string): never {
  throw new SideloadError(message);
}

function log(message: string): void {
  console.log(`${styleText("blue", "==>")} ${message}`);
}

interface ExecOptions {
  cwd?: string;
  input?: string | Buffer;
}

function exec(file: string, args: readonly string[], options: ExecOptions = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", maxBuffer: 1 << 30, ...options });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? result.stderr ?? "",
  };
}

function run(file: string, args: readonly string[], options?: ExecOptions): string {
  const { ok, stdout, stderr } = exec(file, args, options);
  if (!ok) die(`${file} failed: ${(stderr || stdout).trim()}`);
  return stdout;
}

function tryRun(file: string, args: readonly string[], options?: ExecOptions): string | null {
  const { ok, stdout } = exec(file, args, options);
  return ok ? stdout : null;
}

function requireTools(...names: string[]): void {
  const missing = names.filter((name) => tryRun("which", [name]) === null);
  if (missing.length > 0) die(`required tools not found in PATH: ${missing.join(", ")}`);
}

type PlistFormat = "raw" | "json" | "xml1";

function plistValue(
  plist: string | Buffer,
  keyPath: string,
  format: PlistFormat = "raw",
): string | null {
  const value = tryRun("plutil", ["-extract", keyPath, format, "-o", "-", "-"], { input: plist });
  return format === "raw" ? (value?.trimEnd() ?? null) : value;
}

interface Profile {
  name: string;
  appId: string;
  aps: string | null;
  expires: Date;
  certificateSha1: string;
  provisionsAllDevices: boolean;
  devices: string[];
  entitlementsXml: string;
}

function readProfile(file: string): Profile {
  const plist = run("security", ["cms", "-D", "-i", file]);
  const get = (keyPath: string, format?: PlistFormat) => plistValue(plist, keyPath, format);
  const need = (keyPath: string, format?: PlistFormat) =>
    get(keyPath, format) ?? die(`profile has no ${keyPath}`);

  const expires = new Date(need("ExpirationDate"));
  if (Number.isNaN(expires.getTime())) die("could not parse the profile's ExpirationDate");

  const certificate = Buffer.from(need("DeveloperCertificates.0"), "base64");

  return {
    name: need("Name"),
    appId: need("Entitlements.application-identifier"),
    aps: get("Entitlements.aps-environment"),
    expires,
    certificateSha1: hash("sha1", certificate, "hex").toUpperCase(),
    provisionsAllDevices: get("ProvisionsAllDevices") === "true",
    devices: JSON.parse(get("ProvisionedDevices", "json") ?? "[]") as string[],
    entitlementsXml: need("Entitlements", "xml1"),
  };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * First file in `dir`, by name, that ends with `extension` and starts with one of
 * `prefixes`, skipping the `exclude` path.
 */
function findFile(
  dir: string,
  extension: string,
  prefixes: readonly string[] = [""],
  exclude?: string,
): string {
  const name = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .sort()
        .find(
          (file) =>
            file.endsWith(extension) &&
            prefixes.some((p) => file.startsWith(p)) &&
            path.join(dir, file) !== exclude,
        )
    : undefined;
  if (name) return path.join(dir, name);

  const patterns = prefixes.map((p) => `${p}*${extension}`).join(" or ");
  die(`no ${patterns} in ${dir}${exclude ? ` other than ${path.basename(exclude)}` : ""}`);
}

function appBundleName(ipa: string): string {
  const name = run("unzip", ["-Z1", ipa]).match(/^Payload\/([^/]+\.app)\//m)?.[1];
  return name ?? die(`could not find Payload/<name>.app in ${ipa}`);
}

function infoValue(bundle: string, key: string): string | null {
  const plist = path.join(bundle, "Info.plist");
  return fs.existsSync(plist) ? plistValue(fs.readFileSync(plist), key) : null;
}

function bundleExecutable(bundle: string): string | null {
  const name = infoValue(bundle, "CFBundleExecutable");
  if (!name) return null;
  const executable = path.join(bundle, name);
  return fs.existsSync(executable) ? executable : null;
}

function nestedCode(root: string): string[] {
  const depth = (p: string) => p.split(path.sep).length;
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) =>
      entry.isDirectory()
        ? /\.(app|appex|framework)$/.test(entry.name)
        : entry.isFile() && entry.name.endsWith(".dylib"),
    )
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
}

interface BuildOptions {
  inputIpa: string;
  outputIpa: string;
  tweaks: string[];
  bundleId: string | null;
  removeExtensions: boolean;
  profilePath: string;
  entitlementsXml: string;
  identity: string;
}

function injectTweaks(app: string, { inputIpa, tweaks, bundleId, removeExtensions }: BuildOptions) {
  const args = ["-i", inputIpa, "-o", app, "-u", "--overwrite"];
  if (tweaks.length > 0) args.push("-f", ...tweaks);
  if (bundleId !== null) args.push("-b", bundleId);
  if (removeExtensions) args.push("-e");

  log(`cyan: injecting ${tweaks.length} tweak(s) into ${path.basename(app)}...`);
  fs.mkdirSync(path.dirname(app), { recursive: true });
  const { status, error } = spawnSync("cyan", args, { stdio: "inherit" });
  if (error || status !== 0) die(`cyan failed${error ? `: ${error.message}` : ""}`);
  if (!fs.existsSync(app)) die("cyan did not produce an app bundle");
}

function replaceSigningFiles(app: string, profilePath: string): void {
  for (const entry of fs.readdirSync(app, { recursive: true, withFileTypes: true })) {
    if (entry.name === "_CodeSignature" || entry.name === "embedded.mobileprovision") {
      fs.rmSync(path.join(entry.parentPath, entry.name), { recursive: true, force: true });
    }
  }
  fs.copyFileSync(profilePath, path.join(app, "embedded.mobileprovision"));
}

function codesign(target: string, identity: string, entitlements: string | null): void {
  const executable = target.endsWith(".dylib") ? target : bundleExecutable(target);
  if (executable) tryRun("codesign", ["--remove-signature", executable]);

  const entitlementArgs = entitlements
    ? ["--entitlements", entitlements, "--generate-entitlement-der"]
    : [];
  run("codesign", ["--force", "--sign", identity, "--timestamp=none", ...entitlementArgs, target]);
}

function signApp(app: string, identity: string, entitlements: string): void {
  for (const target of [...nestedCode(app), app]) {
    const isExecutableBundle = /\.(app|appex)$/.test(target);
    codesign(target, identity, isExecutableBundle ? entitlements : null);
  }
  run("codesign", ["--verify", "--deep", "--strict", app]);
}

function buildIpa(options: BuildOptions): void {
  using work = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "sideload-"));
  const app = path.join(work.path, "Payload", appBundleName(options.inputIpa));

  injectTweaks(app, options);
  log(
    `${path.basename(app)}: bundle ID ${infoValue(app, "CFBundleIdentifier") ?? "(unknown)"}, ` +
      `version ${infoValue(app, "CFBundleShortVersionString") ?? "(unknown)"}`,
  );

  replaceSigningFiles(app, options.profilePath);
  const entitlements = path.join(work.path, "entitlements.plist");
  fs.writeFileSync(entitlements, options.entitlementsXml);
  log("signing (nested code first)...");
  signApp(app, options.identity, entitlements);

  fs.rmSync(options.outputIpa, { force: true });
  run("zip", ["-qry", options.outputIpa, "Payload"], { cwd: work.path });
  log(`wrote ${options.outputIpa}`);
}

function install(ipa: string, profile: Profile): void {
  requireTools("idevice_id", "ideviceinstaller");
  const connected = run("idevice_id", ["-l"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (connected.length === 0) die("no device connected");
  if (!profile.provisionsAllDevices && !connected.some((udid) => profile.devices.includes(udid))) {
    die("the connected device is not in this profile's device list");
  }

  log("installing...");
  const { ok, stdout, stderr } = exec("ideviceinstaller", ["install", ipa]);
  process.stdout.write(stdout + stderr);
  if (`${stdout}${stderr}`.includes("MismatchedApplicationIdentifierEntitlement")) {
    die(
      "the App Store copy of this app is installed; delete it first (back up chats!), then retry",
    );
  }
  if (!ok) die("ideviceinstaller failed");
}

function main(): void {
  const { values: args } = parseArgs({
    options: {
      install: { type: "boolean", short: "i", default: false },
      "bundle-id": { type: "string" },
    },
  });

  const fromRoot = (file: string) => path.resolve(import.meta.dirname, "..", file);
  const outputIpa = fromRoot("./.local/KakaoTalk-tweaked.ipa");
  const inputIpa = findFile(
    fromRoot(INPUT_DIR),
    ".ipa",
    ["KakaoTalk", "com.iwilab.KakaoTalk"],
    outputIpa,
  );
  const profilePath = findFile(fromRoot(INPUT_DIR), ".mobileprovision");
  const tweaks = TWEAKS.map(fromRoot);
  log(`input ${inputIpa}`);
  log(`profile ${profilePath}`);

  requireTools("cyan", "codesign", "plutil", "security", "unzip", "zip");
  for (const file of tweaks) {
    if (!fs.existsSync(file)) die(`no such file: ${file}`);
  }

  const profile = readProfile(profilePath);
  if (profile.expires < new Date()) die(`profile expired on ${isoDate(profile.expires)}`);
  log(
    `profile '${profile.name}' (${profile.appId}), push: ${profile.aps ?? "NOT ENABLED"}, ` +
      `expires ${isoDate(profile.expires)}`,
  );

  const identity = profile.certificateSha1;
  if (!run("security", ["find-identity", "-v", "-p", "codesigning"]).includes(identity)) {
    die(
      `signing identity ${identity} is not in your keychain; import the matching .p12 with\n` +
        `  security import cert.p12 -k login.keychain`,
    );
  }

  buildIpa({
    inputIpa,
    outputIpa,
    tweaks,
    bundleId: args["bundle-id"] ?? null,
    removeExtensions: false,
    profilePath,
    entitlementsXml: profile.entitlementsXml,
    identity,
  });
  if (args.install) install(outputIpa, profile);
}

try {
  main();
} catch (error) {
  if (!(error instanceof SideloadError)) throw error;
  console.error(`${styleText("red", "error:", { stream: process.stderr })} ${error.message}`);
  process.exitCode = 1;
}
