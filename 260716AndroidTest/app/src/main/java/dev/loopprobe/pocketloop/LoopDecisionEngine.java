package dev.loopprobe.pocketloop;

import java.util.Locale;

/** Pure Java decision core. No Android type is allowed in this file. */
public final class LoopDecisionEngine {
    public static final int MAX_SCOPE_LENGTH = 240;
    public static final int MAX_TEST_COUNT = 1_000_000;

    public enum Verdict {
        PASS,
        FAIL,
        ERROR
    }

    public enum Termination {
        COMPLETED,
        TIMEOUT,
        CANCELLED,
        NOT_STARTED,
        SIGNAL,
        OUTPUT_LIMIT,
        SPAWN_ERROR
    }

    public static final class Observation {
        public final Termination termination;
        public final int exitCode;
        public final int executedTests;
        public final int assertionFailures;
        public final int testErrors;
        public final boolean trustedEvidence;

        public Observation(
                Termination termination,
                int exitCode,
                int executedTests,
                int assertionFailures,
                int testErrors,
                boolean trustedEvidence
        ) {
            this.termination = termination;
            this.exitCode = exitCode;
            this.executedTests = executedTests;
            this.assertionFailures = assertionFailures;
            this.testErrors = testErrors;
            this.trustedEvidence = trustedEvidence;
        }
    }

    public static final class Decision {
        public final Verdict verdict;
        public final String reason;
        public final String summary;
        public final String codexPrompt;

        private Decision(Verdict verdict, String reason, String summary, String codexPrompt) {
            this.verdict = verdict;
            this.reason = reason;
            this.summary = summary;
            this.codexPrompt = codexPrompt;
        }
    }

    public Decision decide(String scope, Observation observation) {
        String normalizedScope = scope == null ? "" : scope.trim();
        if (normalizedScope.isEmpty()) {
            return error("MISSING_SCOPE", "검증 범위를 한 문장으로 먼저 고정하세요.", "(비어 있음)");
        }
        if (normalizedScope.length() > MAX_SCOPE_LENGTH
                || normalizedScope.indexOf('\n') >= 0
                || normalizedScope.indexOf('\r') >= 0) {
            return error(
                    "INVALID_SCOPE",
                    "검증 범위는 줄바꿈 없는 240자 이하의 한 문장이어야 합니다.",
                    "(형식 오류)"
            );
        }
        if (observation == null) {
            return error("MISSING_OBSERVATION", "관찰값이 없어 기능의 참/거짓을 결정할 수 없습니다.", normalizedScope);
        }
        if (observation.termination == null) {
            return error("INVALID_TERMINATION", "종료 상태가 선택되지 않았습니다.", normalizedScope);
        }

        switch (observation.termination) {
            case TIMEOUT:
                return error("TIMEOUT", "시간 초과는 기능 반례가 아닙니다. probe를 더 줄이거나 실행 환경을 복구하세요.", normalizedScope);
            case CANCELLED:
                return error("CANCELLED", "사용자가 중단했습니다. 준비되면 같은 probe를 다시 실행하세요.", normalizedScope);
            case NOT_STARTED:
                return error("NOT_STARTED", "probe가 시작되지 않았습니다. 도구와 설정부터 복구하세요.", normalizedScope);
            case SIGNAL:
                return error("SIGNAL", "외부 signal만으로 코드 결함이나 OOM을 단정할 수 없습니다.", normalizedScope);
            case OUTPUT_LIMIT:
                return error("OUTPUT_LIMIT", "출력 제한에 도달해 최종 증거를 읽지 못했습니다.", normalizedScope);
            case SPAWN_ERROR:
                return error("SPAWN_ERROR", "probe 프로세스를 시작하지 못했습니다.", normalizedScope);
            case COMPLETED:
                break;
            default:
                return error("UNKNOWN_TERMINATION", "알 수 없는 종료 상태입니다.", normalizedScope);
        }

        if (observation.exitCode < 0 || observation.exitCode > 255) {
            return error("INVALID_EXIT_CODE", "정상 종료된 프로세스의 exit code는 0부터 255 사이여야 합니다.", normalizedScope);
        }
        if (!validCount(observation.executedTests)
                || !validCount(observation.assertionFailures)
                || !validCount(observation.testErrors)) {
            return error("INVALID_COUNTS", "테스트 수는 0부터 1,000,000 사이여야 합니다.", normalizedScope);
        }
        long unsuccessful = (long) observation.assertionFailures + observation.testErrors;
        if (unsuccessful > observation.executedTests) {
            return error("INVALID_COUNTS", "failure/error 수가 실행된 테스트 수보다 많아 증거가 모순됩니다.", normalizedScope);
        }
        if (observation.executedTests == 0) {
            return error("NO_TESTS", "실제로 실행된 테스트가 없습니다.", normalizedScope);
        }
        if (!observation.trustedEvidence) {
            return error("UNTRUSTED_EVIDENCE", "현재 실행 또는 Gradle이 검증한 증거가 아닙니다.", normalizedScope);
        }
        if (observation.testErrors > 0) {
            return error("TEST_ERROR", "fixture/runner error가 있어 기능 주장은 아직 미정입니다.", normalizedScope);
        }
        if (observation.exitCode == 0 && observation.assertionFailures > 0) {
            return error("CONTRADICTORY_EVIDENCE", "성공 종료와 assertion failure가 서로 충돌합니다.", normalizedScope);
        }
        if (observation.exitCode != 0 && observation.assertionFailures > 0) {
            return decision(
                    Verdict.FAIL,
                    "ASSERTION_FAILURE",
                    "기능 계약의 실제 반례가 관찰됐습니다.",
                    normalizedScope,
                    "scope 밖은 건드리지 말고 반례를 만드는 동작 또는 계약만 수정한 뒤 같은 probe를 다시 실행해라."
            );
        }
        if (observation.exitCode != 0) {
            return error("INCOMPLETE_PROBE", "비정상 종료했지만 기능 assertion 반례는 없습니다.", normalizedScope);
        }
        return decision(
                Verdict.PASS,
                "CONTRACT_SATISFIED",
                "명시된 범위가 현재 증거를 만족합니다.",
                normalizedScope,
                "멈춰라. 확인된 scope만 보고하고 앱 전체 성공으로 확대하지 마라."
        );
    }

    private static boolean validCount(int value) {
        return value >= 0 && value <= MAX_TEST_COUNT;
    }

    private Decision error(String reason, String summary, String scope) {
        return decision(
                Verdict.ERROR,
                reason,
                summary,
                scope,
                "제품 동작을 추측 수정하지 말고 reason이 가리키는 실행·설정·증거 문제만 해결한 뒤 같은 probe를 다시 실행해라."
        );
    }

    private Decision decision(
            Verdict verdict,
            String reason,
            String summary,
            String scope,
            String action
    ) {
        String prompt = String.format(
                Locale.ROOT,
                "[Pocket Loop]%nVERDICT=%s%nSCOPE=%s%nREASON=%s%nACTION=%s",
                verdict.name(),
                scope,
                reason,
                action
        );
        return new Decision(verdict, reason, summary, prompt);
    }
}
