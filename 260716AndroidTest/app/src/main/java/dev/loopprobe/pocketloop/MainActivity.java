package dev.loopprobe.pocketloop;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.View;
import android.view.ViewGroup;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

/** One-screen, dependency-free companion for deciding the next Codex loop action. */
public final class MainActivity extends Activity {
    private static final String PREFS = "pocket_loop";
    private static final String PREF_SCOPE = "scope";

    private final LoopDecisionEngine engine = new LoopDecisionEngine();

    private EditText scopeInput;
    private Spinner terminationInput;
    private EditText exitCodeInput;
    private EditText testsInput;
    private EditText failuresInput;
    private EditText errorsInput;
    private CheckBox trustedInput;
    private TextView resultText;
    private Button copyButton;
    private LoopDecisionEngine.Decision lastDecision;
    private boolean suppressInvalidation;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(246, 247, 251));
        getWindow().setNavigationBarColor(Color.rgb(246, 247, 251));
        setContentView(buildContent());
        restoreScope();
    }

    private View buildContent() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(Color.rgb(246, 247, 251));

        LinearLayout content = vertical();
        content.setPadding(dp(20), dp(28), dp(20), dp(32));
        scroll.addView(content, matchWrap());

        TextView title = text(getString(R.string.title), 30, Color.rgb(22, 27, 45));
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        content.addView(title);

        TextView subtitle = text(getString(R.string.subtitle), 14, Color.rgb(84, 91, 115));
        content.addView(subtitle, topMargin(dp(4)));

        content.addView(sectionLabel(getString(R.string.scope_label)), topMargin(dp(24)));
        scopeInput = new EditText(this);
        scopeInput.setId(R.id.scope_input);
        scopeInput.setHint(R.string.scope_hint);
        scopeInput.setSingleLine(false);
        scopeInput.setMinLines(2);
        scopeInput.setMaxLines(4);
        scopeInput.setTextSize(16);
        scopeInput.setFilters(new InputFilter[] {
                new InputFilter.LengthFilter(LoopDecisionEngine.MAX_SCOPE_LENGTH)
        });
        scopeInput.setPadding(dp(14), dp(12), dp(14), dp(12));
        scopeInput.setBackground(rounded(Color.WHITE, Color.rgb(216, 220, 234), 12));
        content.addView(scopeInput, topMargin(dp(8)));

        content.addView(sectionLabel(getString(R.string.observation_label)), topMargin(dp(24)));
        LinearLayout card = vertical();
        card.setPadding(dp(14), dp(14), dp(14), dp(14));
        card.setBackground(rounded(Color.WHITE, Color.rgb(228, 231, 240), 16));
        content.addView(card, topMargin(dp(8)));

        card.addView(fieldLabel(getString(R.string.termination_label)));
        terminationInput = new Spinner(this);
        terminationInput.setId(R.id.termination_input);
        ArrayAdapter<CharSequence> adapter = ArrayAdapter.createFromResource(
                this,
                R.array.termination_options,
                android.R.layout.simple_spinner_item
        );
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        terminationInput.setAdapter(adapter);
        card.addView(terminationInput, topMargin(dp(4)));

        exitCodeInput = numberField(card, R.id.exit_code_input, R.string.exit_code_label, "", false);
        testsInput = numberField(card, R.id.tests_input, R.string.tests_label, "", false);
        failuresInput = numberField(card, R.id.failures_input, R.string.failures_label, "", false);
        errorsInput = numberField(card, R.id.errors_input, R.string.errors_label, "", false);

        trustedInput = new CheckBox(this);
        trustedInput.setId(R.id.trusted_input);
        trustedInput.setText(R.string.trusted_evidence);
        trustedInput.setTextSize(14);
        trustedInput.setChecked(false);
        card.addView(trustedInput, topMargin(dp(8)));

        LinearLayout presets = new LinearLayout(this);
        presets.setOrientation(LinearLayout.HORIZONTAL);
        content.addView(presets, topMargin(dp(14)));
        Button passPreset = presetButton(R.id.pass_preset, R.string.pass_preset);
        Button failPreset = presetButton(R.id.fail_preset, R.string.fail_preset);
        Button errorPreset = presetButton(R.id.error_preset, R.string.error_preset);
        presets.addView(passPreset, weighted());
        presets.addView(failPreset, weightedWithLeftMargin());
        presets.addView(errorPreset, weightedWithLeftMargin());

        passPreset.setOnClickListener(view -> applyPreset(
                0, 1, 0, 0, true, LoopDecisionEngine.Termination.COMPLETED
        ));
        failPreset.setOnClickListener(view -> applyPreset(
                1, 1, 1, 0, true, LoopDecisionEngine.Termination.COMPLETED
        ));
        errorPreset.setOnClickListener(view -> applyPreset(
                0, 0, 0, 0, false, LoopDecisionEngine.Termination.TIMEOUT
        ));

        Button decide = new Button(this);
        decide.setId(R.id.decide_button);
        decide.setText(R.string.decide);
        decide.setTextColor(Color.WHITE);
        decide.setTextSize(16);
        decide.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        decide.setBackground(rounded(Color.rgb(54, 89, 217), Color.rgb(54, 89, 217), 12));
        decide.setOnClickListener(view -> evaluate());
        content.addView(decide, fixedHeightWithTop(dp(52), dp(18)));

        resultText = text(getString(R.string.result_waiting), 16, Color.rgb(62, 69, 94));
        resultText.setId(R.id.result_text);
        resultText.setPadding(dp(16), dp(16), dp(16), dp(16));
        resultText.setTextIsSelectable(true);
        resultText.setBackground(rounded(Color.WHITE, Color.rgb(216, 220, 234), 14));
        content.addView(resultText, topMargin(dp(16)));

        copyButton = new Button(this);
        copyButton.setId(R.id.copy_button);
        copyButton.setText(R.string.copy_prompt);
        copyButton.setEnabled(false);
        copyButton.setOnClickListener(view -> copyPrompt());
        content.addView(copyButton, topMargin(dp(8)));

        TextView footer = text(getString(R.string.footer), 12, Color.rgb(105, 111, 132));
        content.addView(footer, topMargin(dp(20)));
        installInvalidationListeners();
        return scroll;
    }

    private void applyPreset(
            int exitCode,
            int tests,
            int failures,
            int errors,
            boolean trusted,
            LoopDecisionEngine.Termination termination
    ) {
        suppressInvalidation = true;
        try {
            if (scopeInput.getText().toString().trim().isEmpty()) {
                scopeInput.setText(R.string.preset_scope);
            }
            exitCodeInput.setText(String.valueOf(exitCode));
            testsInput.setText(String.valueOf(tests));
            failuresInput.setText(String.valueOf(failures));
            errorsInput.setText(String.valueOf(errors));
            trustedInput.setChecked(trusted);
            terminationInput.setSelection(termination.ordinal() + 1);
        } finally {
            suppressInvalidation = false;
        }
        invalidateDecision();
    }

    private void evaluate() {
        try {
            int terminationPosition = terminationInput.getSelectedItemPosition();
            if (terminationPosition <= 0) {
                throw new IllegalArgumentException("프로세스 종료 상태를 선택하세요.");
            }
            LoopDecisionEngine.Termination termination =
                    LoopDecisionEngine.Termination.values()[terminationPosition - 1];
            int exitCode = 0;
            int tests = 0;
            int failures = 0;
            int errors = 0;
            if (termination == LoopDecisionEngine.Termination.COMPLETED) {
                exitCode = integer(exitCodeInput, getString(R.string.exit_code_label));
                tests = integer(testsInput, getString(R.string.tests_label));
                failures = integer(failuresInput, getString(R.string.failures_label));
                errors = integer(errorsInput, getString(R.string.errors_label));
            }
            LoopDecisionEngine.Observation observation = new LoopDecisionEngine.Observation(
                    termination,
                    exitCode,
                    tests,
                    failures,
                    errors,
                    trustedInput.isChecked()
            );
            lastDecision = engine.decide(scopeInput.getText().toString(), observation);
            render(lastDecision);
            getSharedPreferences(PREFS, MODE_PRIVATE)
                    .edit()
                    .putString(PREF_SCOPE, scopeInput.getText().toString().trim())
                    .apply();
        } catch (IllegalArgumentException exception) {
            lastDecision = null;
            copyButton.setEnabled(false);
            resultText.setText(getString(R.string.invalid_input, exception.getMessage()));
            resultText.setTextColor(Color.rgb(160, 78, 24));
            resultText.setBackground(rounded(Color.rgb(255, 247, 231), Color.rgb(241, 184, 104), 14));
        }
    }

    private void render(LoopDecisionEngine.Decision decision) {
        int textColor;
        int fillColor;
        int strokeColor;
        switch (decision.verdict) {
            case PASS:
                textColor = Color.rgb(16, 105, 72);
                fillColor = Color.rgb(232, 249, 241);
                strokeColor = Color.rgb(101, 194, 153);
                break;
            case FAIL:
                textColor = Color.rgb(178, 43, 52);
                fillColor = Color.rgb(255, 238, 239);
                strokeColor = Color.rgb(231, 130, 137);
                break;
            case ERROR:
            default:
                textColor = Color.rgb(160, 78, 24);
                fillColor = Color.rgb(255, 247, 231);
                strokeColor = Color.rgb(241, 184, 104);
                break;
        }
        resultText.setText(getString(
                R.string.decision_result,
                decision.verdict.name(),
                decision.reason,
                decision.summary
        ));
        resultText.setTextColor(textColor);
        resultText.setBackground(rounded(fillColor, strokeColor, 14));
        copyButton.setEnabled(true);
    }

    private void copyPrompt() {
        LoopDecisionEngine.Decision snapshot = lastDecision;
        if (snapshot == null) {
            return;
        }
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        clipboard.setPrimaryClip(ClipData.newPlainText("Pocket Loop", snapshot.codexPrompt));
        Toast.makeText(this, R.string.copied, Toast.LENGTH_SHORT).show();
    }

    private void installInvalidationListeners() {
        TextWatcher watcher = new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence value, int start, int count, int after) {
                // No-op.
            }

            @Override
            public void onTextChanged(CharSequence value, int start, int before, int count) {
                // No-op.
            }

            @Override
            public void afterTextChanged(Editable value) {
                invalidateDecision();
            }
        };
        scopeInput.addTextChangedListener(watcher);
        exitCodeInput.addTextChangedListener(watcher);
        testsInput.addTextChangedListener(watcher);
        failuresInput.addTextChangedListener(watcher);
        errorsInput.addTextChangedListener(watcher);
        trustedInput.setOnCheckedChangeListener((button, checked) -> invalidateDecision());
        terminationInput.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                invalidateDecision();
            }

            @Override
            public void onNothingSelected(AdapterView<?> parent) {
                invalidateDecision();
            }
        });
    }

    private void invalidateDecision() {
        if (suppressInvalidation || resultText == null || copyButton == null) {
            return;
        }
        lastDecision = null;
        copyButton.setEnabled(false);
        resultText.setText(R.string.result_waiting);
        resultText.setTextColor(Color.rgb(62, 69, 94));
        resultText.setBackground(rounded(Color.WHITE, Color.rgb(216, 220, 234), 14));
    }

    private void restoreScope() {
        SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        scopeInput.setText(preferences.getString(PREF_SCOPE, ""));
    }

    private EditText numberField(
            LinearLayout parent,
            int id,
            int label,
            String initial,
            boolean signed
    ) {
        parent.addView(fieldLabel(getString(label)), topMargin(dp(10)));
        EditText input = new EditText(this);
        input.setId(id);
        input.setSingleLine(true);
        input.setText(initial);
        input.setSelectAllOnFocus(true);
        int type = InputType.TYPE_CLASS_NUMBER;
        if (signed) {
            type |= InputType.TYPE_NUMBER_FLAG_SIGNED;
        }
        input.setInputType(type);
        input.setPadding(dp(10), dp(6), dp(10), dp(6));
        input.setBackground(rounded(Color.rgb(249, 250, 253), Color.rgb(220, 224, 236), 8));
        parent.addView(input, topMargin(dp(4)));
        return input;
    }

    private int integer(EditText input, String field) {
        String value = input.getText().toString().trim();
        if (value.isEmpty()) {
            throw new IllegalArgumentException(field + " 값이 비어 있습니다.");
        }
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException(field + " 값이 정수가 아닙니다.");
        }
    }

    private Button presetButton(int id, int label) {
        Button button = new Button(this);
        button.setId(id);
        button.setText(label);
        button.setTextSize(12);
        button.setMinHeight(0);
        button.setMinimumHeight(0);
        return button;
    }

    private TextView sectionLabel(String value) {
        TextView label = text(value, 15, Color.rgb(40, 46, 68));
        label.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return label;
    }

    private TextView fieldLabel(String value) {
        return text(value, 12, Color.rgb(91, 98, 121));
    }

    private TextView text(String value, int sp, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        return view;
    }

    private LinearLayout vertical() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private GradientDrawable rounded(int fill, int stroke, int radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setStroke(dp(1), stroke);
        drawable.setCornerRadius(dp(radiusDp));
        return drawable;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
    }

    private LinearLayout.LayoutParams topMargin(int top) {
        LinearLayout.LayoutParams params = matchWrap();
        params.topMargin = top;
        return params;
    }

    private LinearLayout.LayoutParams fixedHeightWithTop(int height, int top) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                height
        );
        params.topMargin = top;
        return params;
    }

    private LinearLayout.LayoutParams weighted() {
        return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
    }

    private LinearLayout.LayoutParams weightedWithLeftMargin() {
        LinearLayout.LayoutParams params = weighted();
        params.leftMargin = dp(6);
        return params;
    }
}
