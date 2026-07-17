package dev.loopprobe.pocketloop;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.test.ActivityInstrumentationTestCase2;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

@SuppressWarnings("deprecation")
public final class MainActivityInstrumentationTest
        extends ActivityInstrumentationTestCase2<MainActivity> {

    public MainActivityInstrumentationTest() {
        super("dev.loopprobe.pocketloop.debug", MainActivity.class);
    }

    @Override
    protected void setUp() throws Exception {
        super.setUp();
        setActivityInitialTouchMode(true);
    }

    public void testInitialStateCannotClaimPassOrCopy() {
        MainActivity activity = getActivity();
        TextView result = activity.findViewById(R.id.result_text);
        Button copy = activity.findViewById(R.id.copy_button);

        assertFalse(result.getText().toString().startsWith("PASS"));
        assertFalse(copy.isEnabled());
    }

    public void testPassPresetRendersScopedPassAndEnablesCopy() throws Throwable {
        MainActivity activity = getActivity();
        EditText scope = activity.findViewById(R.id.scope_input);
        Button preset = activity.findViewById(R.id.pass_preset);
        Button decide = activity.findViewById(R.id.decide_button);
        TextView result = activity.findViewById(R.id.result_text);
        Button copy = activity.findViewById(R.id.copy_button);

        runTestOnUiThread(() -> {
            scope.setText("빈 사용자 이름을 거부한다");
            preset.performClick();
        });
        getInstrumentation().waitForIdleSync();
        runTestOnUiThread(decide::performClick);
        getInstrumentation().waitForIdleSync();

        assertTrue(result.getText().toString().startsWith("PASS · CONTRACT_SATISFIED"));
        assertTrue(copy.isEnabled());
    }

    public void testChangingInputInvalidatesPreviousPassAndClipboardAction() throws Throwable {
        MainActivity activity = getActivity();
        EditText scope = activity.findViewById(R.id.scope_input);
        EditText failures = activity.findViewById(R.id.failures_input);
        Button preset = activity.findViewById(R.id.pass_preset);
        Button decide = activity.findViewById(R.id.decide_button);
        TextView result = activity.findViewById(R.id.result_text);
        Button copy = activity.findViewById(R.id.copy_button);

        runTestOnUiThread(() -> {
            scope.setText("저장 버튼은 한 번만 항목을 만든다");
            preset.performClick();
        });
        getInstrumentation().waitForIdleSync();
        runTestOnUiThread(decide::performClick);
        getInstrumentation().waitForIdleSync();
        assertTrue(result.getText().toString().startsWith("PASS"));
        assertTrue(copy.isEnabled());

        runTestOnUiThread(() -> failures.setText("1"));
        getInstrumentation().waitForIdleSync();

        assertFalse(result.getText().toString().startsWith("PASS"));
        assertFalse(copy.isEnabled());
    }

    public void testFailPresetRendersOnlyAfterExplicitDecision() throws Throwable {
        MainActivity activity = getActivity();
        EditText scope = activity.findViewById(R.id.scope_input);
        Button preset = activity.findViewById(R.id.fail_preset);
        Button decide = activity.findViewById(R.id.decide_button);
        TextView result = activity.findViewById(R.id.result_text);

        runTestOnUiThread(() -> {
            scope.setText("중복 저장을 거부한다");
            preset.performClick();
        });
        getInstrumentation().waitForIdleSync();
        assertFalse(result.getText().toString().startsWith("FAIL"));
        runTestOnUiThread(decide::performClick);
        getInstrumentation().waitForIdleSync();

        assertTrue(result.getText().toString().startsWith("FAIL · ASSERTION_FAILURE"));
    }

    public void testTimeoutPresetCanNeverRenderPass() throws Throwable {
        MainActivity activity = getActivity();
        EditText scope = activity.findViewById(R.id.scope_input);
        Button preset = activity.findViewById(R.id.error_preset);
        Button decide = activity.findViewById(R.id.decide_button);
        TextView result = activity.findViewById(R.id.result_text);

        runTestOnUiThread(() -> {
            scope.setText("빈 사용자 이름을 거부한다");
            preset.performClick();
        });
        getInstrumentation().waitForIdleSync();
        runTestOnUiThread(decide::performClick);
        getInstrumentation().waitForIdleSync();

        assertTrue(result.getText().toString().startsWith("ERROR · TIMEOUT"));
    }

    public void testTimeoutIgnoresIrrelevantBlankCounts() throws Throwable {
        MainActivity activity = getActivity();
        EditText scope = activity.findViewById(R.id.scope_input);
        EditText exit = activity.findViewById(R.id.exit_code_input);
        EditText tests = activity.findViewById(R.id.tests_input);
        EditText failures = activity.findViewById(R.id.failures_input);
        EditText errors = activity.findViewById(R.id.errors_input);
        Button preset = activity.findViewById(R.id.error_preset);
        Button decide = activity.findViewById(R.id.decide_button);
        TextView result = activity.findViewById(R.id.result_text);

        runTestOnUiThread(() -> {
            scope.setText("시간 안에 응답한다");
            preset.performClick();
        });
        getInstrumentation().waitForIdleSync();
        runTestOnUiThread(() -> {
            exit.setText("");
            tests.setText("");
            failures.setText("");
            errors.setText("");
            decide.performClick();
        });
        getInstrumentation().waitForIdleSync();

        assertTrue(result.getText().toString().startsWith("ERROR · TIMEOUT"));
    }

    public void testMalformedInputDoesNotCrashOrEnableCopy() throws Throwable {
        MainActivity activity = getActivity();
        EditText scope = activity.findViewById(R.id.scope_input);
        Button preset = activity.findViewById(R.id.pass_preset);
        EditText tests = activity.findViewById(R.id.tests_input);
        Button decide = activity.findViewById(R.id.decide_button);
        TextView result = activity.findViewById(R.id.result_text);
        Button copy = activity.findViewById(R.id.copy_button);

        runTestOnUiThread(() -> {
            scope.setText("빈 값을 거부한다");
            preset.performClick();
        });
        getInstrumentation().waitForIdleSync();
        runTestOnUiThread(() -> {
            tests.setText("");
            decide.performClick();
        });
        getInstrumentation().waitForIdleSync();

        assertTrue(result.getText().toString().startsWith("ERROR · INVALID_INPUT"));
        assertFalse(copy.isEnabled());
    }

    public void testCopiedPromptIsTheImmutableDecisionSnapshot() throws Throwable {
        MainActivity activity = getActivity();
        EditText scope = activity.findViewById(R.id.scope_input);
        Button preset = activity.findViewById(R.id.pass_preset);
        Button decide = activity.findViewById(R.id.decide_button);
        Button copy = activity.findViewById(R.id.copy_button);

        runTestOnUiThread(() -> {
            scope.setText("원래 범위만 검증한다");
            preset.performClick();
        });
        getInstrumentation().waitForIdleSync();
        runTestOnUiThread(() -> {
            decide.performClick();
            copy.performClick();
        });
        getInstrumentation().waitForIdleSync();

        ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = clipboard.getPrimaryClip();
        assertNotNull(clip);
        String copied = clip.getItemAt(0).coerceToText(activity).toString();
        assertTrue(copied.contains("SCOPE=원래 범위만 검증한다"));
        assertFalse(copied.contains("SCOPE=바뀐 범위"));

        runTestOnUiThread(() -> scope.setText("바뀐 범위"));
        getInstrumentation().waitForIdleSync();
        assertFalse(copy.isEnabled());
    }
}
