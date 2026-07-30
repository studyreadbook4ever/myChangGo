import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_STT_PORT,
  LOCAL_CAPTION_STACK_SCHEMA,
  LOOPBACK_HOST,
  PINNED_MODELS,
  PINNED_VAD_MODEL,
  PINNED_WHISPER_CPP,
  assertSha256,
  buildWhisperServerArgs,
  createInstallConfig,
  extensionOriginForPath,
  installedProfileSummary,
  parseLocalCaptionStackArgs,
  renderSystemdUserUnit,
  resolveSemanticProfile,
  resolveStackPaths,
  secretFreeConfigJson,
  supportedNodeVersion,
  systemdRestartCommands,
  systemdStartCommands,
  systemdStopCommands
} from "../scripts/local-caption-stack-core.mjs";
import {
  commandLineRunsExactCaptionCli,
  foregroundPidRecordVersion,
  isSystemdRunningState,
  managedChildEnvironment,
  helpText,
  parseProcStartTime,
  waitForManagedShutdown,
  withoutCaptionSecrets
} from "../scripts/local-caption-stack.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function hardware(overrides = {}) {
  return {
    platform: "linux",
    cpuCount: 8,
    totalMemoryBytes: 16 * 1024 ** 3,
    nvidiaDetected: false,
    nvccAvailable: false,
    ...overrides
  };
}

function fixturePaths() {
  return resolveStackPaths({
    env: {
      XDG_DATA_HOME: "/tmp/kirinuki-test/data",
      XDG_CONFIG_HOME: "/tmp/kirinuki-test/config",
      XDG_STATE_HOME: "/tmp/kirinuki-test/state",
      XDG_RUNTIME_DIR: "/tmp/kirinuki-test/run"
    },
    homeDir: "/tmp/kirinuki-test/home",
    repoRoot: "/opt/kirinuki"
  });
}

test("CLI의 Node 최소 버전은 package 계약인 20.9.0을 정확히 지킨다", () => {
  assert.equal(supportedNodeVersion("20.8.9"), false);
  assert.equal(supportedNodeVersion("20.9.0"), true);
  assert.equal(supportedNodeVersion("20.10.0"), true);
  assert.equal(supportedNodeVersion("21.0.0"), true);
  assert.equal(supportedNodeVersion("invalid"), false);
});

test("Linux foreground identity는 proc start tick과 systemd active-like 상태를 정확히 읽는다", () => {
  const fieldsFromState = [
    "S",
    ...Array.from({ length: 18 }, () => "0"),
    "987654",
    "0"
  ];
  assert.equal(
    parseProcStartTime(`123 (node worker) ${fieldsFromState.join(" ")}`),
    "987654"
  );
  assert.equal(parseProcStartTime("invalid"), null);
  for (const state of [
    "active",
    "activating",
    "reloading",
    "deactivating"
  ]) {
    assert.equal(isSystemdRunningState(state), true);
  }
  assert.equal(isSystemdRunningState("inactive"), false);
  assert.equal(isSystemdRunningState("failed"), false);

  const expectedCliPath = path.join(
    packageRoot,
    "scripts",
    "local-caption-stack.mjs"
  );
  const legacy = {
    pid: 123,
    startedAt: "2026-07-30T00:00:00.000Z",
    command: "start"
  };
  assert.equal(foregroundPidRecordVersion(legacy), "legacy");
  assert.equal(foregroundPidRecordVersion({
    ...legacy,
    schema: "unknown"
  }), null);
  assert.equal(commandLineRunsExactCaptionCli({
    commandLine:
      `/usr/bin/node\u0000${expectedCliPath}\u0000start\u0000--foreground\u0000`,
    processCwd: packageRoot,
    expectedCliPath
  }), true);
  assert.equal(commandLineRunsExactCaptionCli({
    commandLine:
      "/usr/bin/node\u0000/opt/foreign-clone/scripts/local-caption-stack.mjs\u0000start\u0000",
    processCwd: "/opt/foreign-clone",
    expectedCliPath
  }), false);
});

test("관리형 종료 확인은 service·identity·입증된 포트가 모두 내려갈 때만 끝난다", async () => {
  let inspection = 0;
  await waitForManagedShutdown({
    isSystemdActive: () => inspection < 1,
    isForegroundActive: () => inspection < 2,
    isManagedGatewayActive: () => inspection < 3,
    isManagedSttPortListening: () => inspection < 4,
    isManagedGatewayPortListening: () => {
      inspection += 1;
      return inspection < 5;
    },
    timeoutMs: 100,
    pollIntervalMs: 1
  });
  assert.equal(inspection, 5);
  await assert.rejects(
    waitForManagedShutdown({
      isManagedGatewayPortListening: () => true,
      timeoutMs: 5,
      pollIntervalMs: 1
    }),
    /관리형 gateway 포트/u
  );
});

test("모든 child 환경은 API 비밀을 제거하고 loopback proxy 우회를 강제한다", () => {
  const sanitized = withoutCaptionSecrets({
    PATH: "/usr/bin",
    UNUSED_API_KEY: "provider-secret",
    SOME_ACCESS_KEY: "provider-secret",
    DATABASE_PASSWORD: "database-secret",
    SAFE_SETTING: "kept"
  });
  assert.deepEqual(sanitized, {
    PATH: "/usr/bin",
    SAFE_SETTING: "kept"
  });
  const managed = managedChildEnvironment({
    PATH: "/usr/bin",
    NODE_USE_ENV_PROXY: "1",
    NO_PROXY: "metadata.internal",
    OTHER_TOKEN: "secret"
  });
  assert.equal(managed.OTHER_TOKEN, undefined);
  assert.match(managed.NO_PROXY, /(?:^|,)127\.0\.0\.1(?:,|$)/u);
  assert.match(managed.NO_PROXY, /(?:^|,)localhost(?:,|$)/u);
  assert.equal(managed.no_proxy, managed.NO_PROXY);
});

test("whisper.cpp·모델·VAD는 변경 불가능한 revision과 SHA-256에 고정된다", () => {
  assert.match(PINNED_WHISPER_CPP.version, /^v\d+\.\d+\.\d+$/u);
  assert.match(PINNED_WHISPER_CPP.commit, /^[0-9a-f]{40}$/u);
  assert.ok(PINNED_WHISPER_CPP.archive.url.includes(PINNED_WHISPER_CPP.commit));
  assert.match(PINNED_WHISPER_CPP.archive.sha256, /^[0-9a-f]{64}$/u);
  assert.ok(PINNED_WHISPER_CPP.archive.size > 1_000_000);

  for (const artifact of [
    ...Object.values(PINNED_MODELS),
    PINNED_VAD_MODEL
  ]) {
    assert.match(artifact.url, /\/resolve\/[0-9a-f]{40}\//u);
    assert.doesNotMatch(artifact.url, /\/(?:main|master)\//u);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(artifact.size > 100_000);
  }
});

test("SHA 검증기는 일치한 artifact만 통과시킨다", () => {
  const expected =
    "df0bd58f903d0961f74800046dbf6789273b4e96c61e9d50413dcf9a3857e31c";
  assert.equal(assertSha256("kirinuki", expected), expected);
  assert.throws(
    () => assertSha256("tampered", expected, "model"),
    /SHA-256 불일치/u
  );
});

test("기본 draft profile은 고정 Whisper Tiny 초벌 모델을 고른다", () => {
  const profile = resolveSemanticProfile(undefined, hardware(), "auto");
  assert.equal(profile.requestedProfile, "draft");
  assert.equal(profile.effectiveProfile, "draft");
  assert.equal(profile.model.id, "tiny-q5_1");
  assert.equal(profile.model.name, "ggml-tiny-q5_1.bin");
  assert.equal(
    profile.model.sha256,
    "818710568da3ca15689e31a743197b520007872ff9576237bda97bd1b469c3d7"
  );
  assert.equal(profile.model.size, 32_152_673);
  assert.equal(profile.semantics.language, "ko");
  assert.equal(profile.semantics.timestamps, "segment+word");
  assert.equal(profile.semantics.vad, true);
});

test("명시한 auto·light·quality profile은 기존 모델 선택을 유지한다", () => {
  const normal = resolveSemanticProfile("auto", hardware(), "auto");
  assert.equal(normal.effectiveProfile, "auto");
  assert.equal(normal.model.id, "small-q5_1");
  assert.equal(normal.backend, "cpu");

  const lowMemory = resolveSemanticProfile("auto", hardware({
    totalMemoryBytes: 4 * 1024 ** 3
  }), "auto");
  assert.equal(lowMemory.effectiveProfile, "light");
  assert.equal(lowMemory.model.id, "base-q5_1");

  const light = resolveSemanticProfile("light", hardware(), "auto");
  const quality = resolveSemanticProfile("quality", hardware(), "cpu");
  assert.equal(light.model.id, "base-q5_1");
  assert.equal(quality.model.id, "medium-q5_0");
  assert.ok(quality.threads >= light.threads);
  assert.equal(quality.semantics.language, "ko");
  assert.equal(quality.semantics.timestamps, "segment+word");
  assert.equal(quality.semantics.vad, true);
});

test("doctor용 설치 요약은 CLI 기본 후보가 아니라 실제 설치 프로필과 모델을 보고한다", () => {
  const installed = createInstallConfig(
    fixturePaths(),
    resolveSemanticProfile("light", hardware(), "cpu")
  );
  assert.deepEqual(installedProfileSummary(installed), {
    requested: "light",
    effective: "light",
    model: "base-q5_1",
    backend: "cpu"
  });
  assert.equal(installedProfileSummary(null), null);
});

test("CPU가 안전한 기본이고 NVIDIA와 nvcc가 모두 있을 때만 CUDA를 선택한다", () => {
  assert.equal(
    resolveSemanticProfile("auto", hardware(), "auto").backend,
    "cpu"
  );
  assert.equal(
    resolveSemanticProfile("auto", hardware({
      nvidiaDetected: true,
      nvccAvailable: false
    }), "auto").backend,
    "cpu"
  );
  assert.equal(
    resolveSemanticProfile("auto", hardware({
      nvidiaDetected: true,
      nvccAvailable: true
    }), "auto").backend,
    "cuda"
  );
  assert.throws(
    () => resolveSemanticProfile("auto", hardware(), "cuda"),
    /CUDA backend/u
  );
});

test("Whisper 서버 인자는 VAD와 한국어 타임스탬프를 켜고 127.0.0.1만 사용한다", () => {
  const paths = fixturePaths();
  const cpuConfig = createInstallConfig(
    paths,
    resolveSemanticProfile("auto", hardware(), "cpu")
  );
  const requestPath = `/kirinuki-${"a".repeat(48)}`;
  const cpuArgs = buildWhisperServerArgs(cpuConfig, { requestPath });
  assert.deepEqual(
    cpuArgs.slice(cpuArgs.indexOf("--host"), cpuArgs.indexOf("--host") + 2),
    ["--host", LOOPBACK_HOST]
  );
  assert.ok(cpuArgs.includes("--vad"));
  assert.ok(cpuArgs.includes("--vad-model"));
  assert.ok(cpuArgs.includes("--split-on-word"));
  assert.ok(cpuArgs.includes("--no-gpu"));
  assert.equal(
    cpuArgs[cpuArgs.indexOf("--request-path") + 1],
    requestPath
  );
  assert.equal(cpuArgs[cpuArgs.indexOf("--language") + 1], "ko");

  const cudaConfig = createInstallConfig(
    paths,
    resolveSemanticProfile("auto", hardware({
      nvidiaDetected: true,
      nvccAvailable: true
    }), "auto")
  );
  const cudaArgs = buildWhisperServerArgs(cudaConfig, { requestPath });
  assert.ok(cudaArgs.includes("--flash-attn"));
  assert.ok(!cudaArgs.includes("--no-gpu"));

  assert.throws(
    () => buildWhisperServerArgs(
      { ...cpuConfig, host: "0.0.0.0" },
      { requestPath }
    ),
    /127\.0\.0\.1/u
  );
  assert.throws(
    () => buildWhisperServerArgs(cpuConfig),
    /비공개 요청 경로/u
  );
});

test("설정은 loopback·semantic 정보만 담고 API 키나 token을 직렬화하지 않는다", () => {
  const config = createInstallConfig(
    fixturePaths(),
    resolveSemanticProfile("light", hardware(), "cpu")
  );
  assert.equal(config.schema, LOCAL_CAPTION_STACK_SCHEMA);
  assert.equal(config.host, LOOPBACK_HOST);
  assert.equal(config.sttPort, DEFAULT_STT_PORT);
  assert.equal(config.gatewayPort, DEFAULT_GATEWAY_PORT);
  assert.match(config.origin, /^chrome-extension:\/\/[a-p]{32}$/u);
  const serialized = secretFreeConfigJson(config, [
    "should-never-appear",
    "another-runtime-secret"
  ]);
  assert.doesNotMatch(serialized, /api[_-]?key|agent[_-]?token/iu);
  assert.doesNotMatch(serialized, /should-never-appear/u);
});

test("확장 Origin은 절대 경로에서 결정적으로 파생된다", () => {
  const first = extensionOriginForPath("/opt/kirinuki/extension");
  const again = extensionOriginForPath("/opt/kirinuki/extension");
  const moved = extensionOriginForPath("/opt/kirinuki-copy/extension");
  assert.equal(first, again);
  assert.notEqual(first, moved);
  assert.match(first, /^chrome-extension:\/\/[a-p]{32}$/u);
});

test("systemd-user unit은 자동 페어링·로컬 STT·exact Origin만 환경에 넣는다", () => {
  const origin = extensionOriginForPath("/opt/kirinuki/extension");
  const unit = renderSystemdUserUnit({
    nodePath: "/usr/bin/node",
    cliPath: "/opt/kirinuki/scripts/local-caption-stack.mjs",
    repoRoot: "/opt/kirinuki",
    origin
  });
  assert.match(unit, /KIRINUKI_AUTO_PAIR=1/u);
  assert.match(unit, /KIRINUKI_STT_MODE=local-whispercpp/u);
  assert.ok(unit.includes(`KIRINUKI_ALLOWED_ORIGIN=${origin}`));
  assert.match(unit, /NoNewPrivileges=true/u);
  assert.match(unit, /ProtectSystem=strict/u);
  assert.match(unit, /ProtectHome=read-only/u);
  assert.match(unit, /^WorkingDirectory=\/opt\/kirinuki$/mu);
  assert.doesNotMatch(
    unit,
    /API_KEY|KIRINUKI_AGENT_TOKEN/u
  );
  assert.throws(
    () => renderSystemdUserUnit({
      nodePath: "/usr/bin/node",
      cliPath: "/opt/kirinuki/scripts/local-caption-stack.mjs",
      repoRoot: "/opt/kirinuki",
      origin: "*"
    }),
    /정확한 확장 프로그램 Origin/u
  );
});

test("systemd start·stop 명령에는 API 키 값이나 환경 import가 없다", () => {
  const commands = [
    ...systemdStartCommands(),
    ...systemdRestartCommands(),
    ...systemdStopCommands()
  ];
  const serialized = JSON.stringify(commands);
  assert.doesNotMatch(serialized, /API_KEY|TOKEN|import-environment/iu);
  assert.ok(commands.every((command) => command.file === "systemctl"));
  assert.ok(commands.every((command) => command.args.includes("--user")));
});

test("CLI는 5개 공개 명령과 profile만 받고 비밀 옵션을 거부한다", () => {
  assert.deepEqual(
    parseLocalCaptionStackArgs(["setup"]),
    {
      command: "setup",
      options: {
        profile: "draft",
        backend: "auto",
        foreground: false,
        dryRun: false,
        json: false
      }
    }
  );
  assert.deepEqual(
    parseLocalCaptionStackArgs([
      "start",
      "--foreground",
      "--profile=light",
      "--backend",
      "cpu"
    ]),
    {
      command: "start",
      options: {
        profile: "light",
        backend: "cpu",
        foreground: true,
        dryRun: false,
        json: false
      }
    }
  );
  assert.throws(
    () => parseLocalCaptionStackArgs(["start", "--api-key", "secret"]),
    /명령행 인자로 받을 수 없습니다/u
  );
  assert.throws(
    () => parseLocalCaptionStackArgs(["setup", "--profile", "huge"]),
    /profile은/u
  );
});

test("CLI 도움말은 draft Tiny 기본값과 기존 명시 프로필을 함께 안내한다", () => {
  const help = helpText();
  assert.match(help, /draft\s+기본값.+Whisper Tiny tiny-q5_1/u);
  assert.match(help, /auto\s+균형형 small-q5_1/u);
  assert.match(help, /light\s+저사양 CPU용 base-q5_1/u);
  assert.match(help, /quality\s+정확도 우선 medium-q5_0/u);
});

test("package scripts는 doctor/setup/start/status/stop을 Node CLI로 노출한다", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8")
  );
  assert.match(packageJson.engines.node, />=20/u);
  assert.equal(
    packageJson.scripts["caption-stack"],
    "node scripts/local-caption-stack.mjs"
  );
  for (const command of ["doctor", "setup", "start", "status", "stop"]) {
    assert.equal(
      packageJson.scripts[`caption-stack:${command}`],
      `node scripts/local-caption-stack.mjs ${command}`
    );
  }
});

test("CLI source는 gateway를 오케스트레이션하되 키를 env·argv에 주입하지 않는다", async () => {
  const source = await readFile(
    path.join(packageRoot, "scripts", "local-caption-stack.mjs"),
    "utf8"
  );
  assert.match(source, /caption-gateway\.mjs/u);
  assert.match(source, /KIRINUKI_AUTO_PAIR:\s*"1"/u);
  assert.match(source, /KIRINUKI_STT_MODE:\s*"local-whispercpp"/u);
  assert.match(source, /randomBytes\(24\).*toString\("hex"\)/u);
  assert.match(source, /open\(paths\.pidPath,\s*"wx"/u);
  assert.match(source, /removePidFileIfOwned\(paths,\s*pidRecord\)/u);
  assert.doesNotMatch(source, /writeAtomic\(\s*paths\.pidPath/u);
  assert.match(source, /receivedBytes > artifact\.size/u);
  assert.doesNotMatch(source, /API_KEY\s*:/u);
  assert.doesNotMatch(source, /KIRINUKI_AGENT_TOKEN\s*:/u);
});
