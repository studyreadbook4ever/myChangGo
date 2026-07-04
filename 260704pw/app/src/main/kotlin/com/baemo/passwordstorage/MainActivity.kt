package com.baemo.passwordstorage

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.DialogInterface
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.text.Editable
import android.text.InputType
import android.text.TextUtils
import android.text.TextWatcher
import android.util.Base64
import android.util.TypedValue
import android.view.ActionMode
import android.view.Gravity
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TableLayout
import android.widget.TableRow
import android.widget.TextView
import android.widget.Toast
import java.io.IOException
import java.text.SimpleDateFormat
import java.nio.charset.StandardCharsets
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executor
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private val mainExecutor = Executor { command -> handler.post(command) }
    private val passwordCells = arrayOfNulls<TextView>(ENTRY_COUNT)
    private val editableCells = Array(EDITABLE_COLUMN_COUNT) { arrayOfNulls<EditText>(ENTRY_COUNT) }
    private val lastCheckedCells = arrayOfNulls<TextView>(ENTRY_COUNT)
    private val hideTasks = mutableMapOf<Int, Runnable>()

    private lateinit var enterpriseStore: EnterpriseStore
    private lateinit var cellPrefs: android.content.SharedPreferences
    private lateinit var vault: PasswordVault
    private var selectedEnterpriseId: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            setRecentsScreenshotEnabled(false)
        }

        enterpriseStore = EnterpriseStore(this)
        cellPrefs = getSharedPreferences("enterprise_cells", MODE_PRIVATE)
        vault = PasswordVault(this)
        showEnterprisePicker()
    }

    override fun onPause() {
        super.onPause()
        maskAllPasswords()
        clearClipboard()
    }

    override fun onStop() {
        super.onStop()
        maskAllPasswords()
        clearClipboard()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        clearClipboard()
        super.onDestroy()
    }

    private fun showEnterprisePicker() {
        selectedEnterpriseId = null
        maskAllPasswords()
        setContentView(createEnterprisePicker())
    }

    private fun openEnterprise(enterpriseId: String) {
        selectedEnterpriseId = enterpriseId
        hideTasks.clear()
        setContentView(createVaultContent(enterpriseId))
    }

    private fun createEnterprisePicker(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(COLOR_BG)
            setPadding(dp(24f), dp(52f), dp(24f), dp(18f))
            filterTouchesWhenObscured = true
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        val titleBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }

        val eyebrow = TextView(this).apply {
            text = "LOCAL VAULTS"
            setTextColor(COLOR_MUTED)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f)
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = 0.08f
        }
        titleBox.addView(eyebrow, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)

        val title = TextView(this).apply {
            text = "Password Store"
            setTextColor(COLOR_HEADER)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
            typeface = Typeface.DEFAULT_BOLD
            isSingleLine = true
            ellipsize = TextUtils.TruncateAt.END
        }
        titleBox.addView(title, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)

        header.addView(titleBox, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        header.addView(createAddEnterpriseButton(), LinearLayout.LayoutParams(dp(116f), dp(42f)))
        root.addView(header, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)

        val subtitle = TextView(this).apply {
            text = "엔터프라이즈를 추가하거나 선택하세요"
            setTextColor(COLOR_MUTED)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setPadding(0, dp(4f), 0, dp(18f))
        }
        root.addView(subtitle, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)

        val scroll = ScrollView(this).apply {
            isFillViewport = true
            clipToPadding = false
        }

        val list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        val enterprises = enterpriseStore.listEnterprises()
        if (enterprises.isEmpty()) {
            list.addView(createEmptyEnterpriseState())
        } else {
            enterprises.forEach { enterprise ->
                list.addView(
                    createEnterpriseRow(enterprise),
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    dp(76f)
                )
            }
        }

        scroll.addView(
            list,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            )
        )
        root.addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        return root
    }

    private fun createAddEnterpriseButton(): TextView {
        return TextView(this).apply {
            text = "추가"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            background = rounded(COLOR_ACCENT, COLOR_ACCENT, 6)
            setCompoundDrawablesWithIntrinsicBounds(R.drawable.ic_add_enterprise, 0, 0, 0)
            compoundDrawablePadding = dp(6f)
            contentDescription = "엔터프라이즈 추가"
            filterTouchesWhenObscured = true
            setOnClickListener { requestEnterpriseName() }
        }
    }

    private fun createEmptyEnterpriseState(): TextView {
        return TextView(this).apply {
            text = "아직 엔터프라이즈가 없습니다.\n위 버튼으로 첫 금고를 만들어 주세요."
            setTextColor(COLOR_MUTED)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            gravity = Gravity.CENTER
            background = rounded(COLOR_PANEL, COLOR_BORDER, 8)
            setPadding(dp(18f), dp(34f), dp(18f), dp(34f))
        }
    }

    private fun createEnterpriseRow(enterprise: Enterprise): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = rounded(COLOR_PANEL, COLOR_BORDER, 8)
            setPadding(dp(12f), 0, dp(12f), 0)
            filterTouchesWhenObscured = true
            setOnClickListener { authenticateEnterpriseEntry(enterprise.id) }
        }

        val avatar = TextView(this).apply {
            text = enterpriseInitials(enterprise.name)
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            background = rounded(enterpriseColor(enterprise.id), enterpriseColor(enterprise.id), 6)
            includeFontPadding = false
        }
        row.addView(avatar, LinearLayout.LayoutParams(dp(42f), dp(42f)))

        val textBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(12f), 0, dp(8f), 0)
        }
        val name = TextView(this).apply {
            text = enterprise.name
            setTextColor(COLOR_TEXT)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            typeface = Typeface.DEFAULT_BOLD
            isSingleLine = true
            ellipsize = TextUtils.TruncateAt.END
        }
        textBox.addView(name, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)

        val detail = TextView(this).apply {
            text = "7 x 40 offline biometric vault"
            setTextColor(COLOR_MUTED)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            isSingleLine = true
            ellipsize = TextUtils.TruncateAt.END
        }
        textBox.addView(detail, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        row.addView(textBox, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

        val chevron = TextView(this).apply {
            text = ">"
            setTextColor(COLOR_MUTED)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            gravity = Gravity.CENTER
            includeFontPadding = false
        }
        row.addView(chevron, LinearLayout.LayoutParams(dp(24f), dp(42f)))

        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, dp(8f))
            addView(row, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT)
        }
    }

    private fun enterpriseInitials(name: String): String {
        return name.trim().take(2).ifBlank { "E" }.uppercase(Locale.US)
    }

    private fun enterpriseColor(id: String): Int {
        val colors = intArrayOf(
            Color.rgb(124, 58, 237),
            Color.rgb(14, 116, 144),
            Color.rgb(22, 163, 74),
            Color.rgb(194, 65, 12),
            Color.rgb(71, 85, 105)
        )
        return colors[(id.hashCode() and Int.MAX_VALUE) % colors.size]
    }

    private fun requestEnterpriseName() {
        val input = NoCopyEditText(this).apply {
            hint = "엔터프라이즈 이름"
            setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setPadding(dp(12f), dp(10f), dp(12f), dp(10f))
            background = rounded(Color.WHITE, COLOR_BORDER, 8)
            filterTouchesWhenObscured = true
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            }
        }
        val wrapper = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20f), dp(8f), dp(20f), 0)
            addView(input, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        }

        val dialog = AlertDialog.Builder(this)
            .setTitle("엔터프라이즈 추가")
            .setView(wrapper)
            .setPositiveButton("추가", null)
            .setNegativeButton("취소", null)
            .create()

        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val name = input.text?.toString()?.trim().orEmpty()
                if (name.isBlank()) {
                    input.error = "이름을 입력해 주세요"
                    return@setOnClickListener
                }
                val enterprise = enterpriseStore.addEnterprise(name)
                dialog.dismiss()
                authenticateEnterpriseEntry(enterprise.id)
            }
        }
        dialog.show()
        dialog.window?.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        input.requestFocus()
    }

    private fun authenticateEnterpriseEntry(enterpriseId: String) {
        val enterpriseName = enterpriseStore.nameOf(enterpriseId)
        val cancellationSignal = CancellationSignal()
        val prompt = BiometricPrompt.Builder(this)
            .setTitle("엔터프라이즈 열기")
            .setSubtitle(enterpriseName)
            .setNegativeButton("취소", mainExecutor, DialogInterface.OnClickListener { _, _ ->
                cancellationSignal.cancel()
            })
            .build()

        prompt.authenticate(
            cancellationSignal,
            mainExecutor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    Toast.makeText(this@MainActivity, errString, Toast.LENGTH_SHORT).show()
                }

                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    openEnterprise(enterpriseId)
                }

                override fun onAuthenticationFailed() {
                    Toast.makeText(this@MainActivity, "인증 실패", Toast.LENGTH_SHORT).show()
                }
            }
        )
    }

    private fun createVaultContent(enterpriseId: String): View {
        val enterpriseName = enterpriseStore.nameOf(enterpriseId)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(COLOR_BG)
            setPadding(dp(14f), dp(14f), dp(14f), dp(12f))
            filterTouchesWhenObscured = true
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        val backButton = ImageButton(this).apply {
            setImageResource(R.drawable.ic_back)
            setBackgroundColor(Color.TRANSPARENT)
            setColorFilter(COLOR_TEXT)
            contentDescription = "엔터프라이즈 선택으로 돌아가기"
            tooltipText = "돌아가기"
            filterTouchesWhenObscured = true
            setOnClickListener { showEnterprisePicker() }
        }
        header.addView(backButton, LinearLayout.LayoutParams(dp(44f), dp(44f)))

        val titleBox = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(4f), 0, dp(8f), 0)
        }
        val title = TextView(this).apply {
            text = enterpriseName
            setTextColor(COLOR_HEADER)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 22f)
            typeface = Typeface.DEFAULT_BOLD
            isSingleLine = true
            ellipsize = TextUtils.TruncateAt.END
        }
        val subtitle = TextView(this).apply {
            text = "Slot / ID / Password / Name / COMMENT / Last Checked / Reset"
            setTextColor(COLOR_MUTED)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            isSingleLine = true
            ellipsize = TextUtils.TruncateAt.END
        }
        titleBox.addView(title, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        titleBox.addView(subtitle, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        header.addView(titleBox, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

        val shape = TextView(this).apply {
            text = "7 x 40"
            setTextColor(COLOR_MUTED)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            gravity = Gravity.CENTER
            background = rounded(COLOR_PANEL, COLOR_BORDER, 16)
            setPadding(dp(12f), dp(7f), dp(12f), dp(7f))
        }
        header.addView(shape)

        root.addView(
            header,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { setMargins(0, 0, 0, dp(10f)) }
        )

        val verticalScroll = ScrollView(this).apply {
            isFillViewport = true
            clipToPadding = false
            filterTouchesWhenObscured = true
        }

        val horizontalScroll = HorizontalScrollView(this).apply {
            isFillViewport = true
            clipToPadding = false
            filterTouchesWhenObscured = true
        }

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(createColumnGuide())
            addView(createVaultTable(enterpriseId))
        }

        horizontalScroll.addView(
            content,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            )
        )
        verticalScroll.addView(
            horizontalScroll,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT
            )
        )
        root.addView(verticalScroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        return root
    }

    private fun createColumnGuide(): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            columnLabels.forEachIndexed { index, label ->
                addView(
                    TextView(this@MainActivity).apply {
                        text = label
                        setTextColor(COLOR_HEADER_TEXT)
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                        typeface = Typeface.DEFAULT_BOLD
                        gravity = Gravity.CENTER
                        includeFontPadding = false
                        background = rounded(COLOR_HEADER, COLOR_HEADER, 8)
                    },
                    LinearLayout.LayoutParams(dp(CELL_WIDTHS_DP[index].toFloat()), dp(36f)).apply {
                        setMargins(dp(3f), dp(3f), dp(3f), dp(4f))
                    }
                )
            }
        }
    }

    private fun createVaultTable(enterpriseId: String): TableLayout {
        return TableLayout(this).apply {
            isShrinkAllColumns = false
            isStretchAllColumns = false
            setBackgroundColor(COLOR_BG)
            filterTouchesWhenObscured = true

            repeat(ENTRY_COUNT) { row ->
                val tableRow = TableRow(this@MainActivity).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    isBaselineAligned = false
                }
                repeat(TABLE_COLUMN_COUNT) { column ->
                    tableRow.addView(createVaultCell(enterpriseId, row, column), cellParams(column))
                }
                addView(
                    tableRow,
                    TableLayout.LayoutParams(
                        TableLayout.LayoutParams.WRAP_CONTENT,
                        TableLayout.LayoutParams.WRAP_CONTENT
                    )
                )
            }
        }
    }

    private fun cellParams(column: Int): TableRow.LayoutParams {
        return TableRow.LayoutParams(dp(CELL_WIDTHS_DP[column].toFloat()), dp(CELL_HEIGHT_DP.toFloat())).apply {
            setMargins(dp(3f), dp(3f), dp(3f), dp(3f))
        }
    }

    private fun createVaultCell(enterpriseId: String, row: Int, column: Int): View {
        return when (column) {
            SLOT_COLUMN -> baseTextCell().apply {
                text = slotName(row)
                setTextColor(COLOR_HEADER_TEXT)
                typeface = Typeface.DEFAULT_BOLD
                background = rounded(COLOR_HEADER, COLOR_HEADER, 8)
                contentDescription = "${slotName(row)} fixed slot"
            }

            ID_COLUMN -> idCell(enterpriseId, row)

            PASSWORD_COLUMN -> baseTextCell().apply {
                text = MASK
                setTextColor(COLOR_TEXT)
                typeface = Typeface.MONOSPACE
                background = rounded(COLOR_PASSWORD, COLOR_BORDER, 8)
                contentDescription = "${slotName(row)} password"
                filterTouchesWhenObscured = true
                isHapticFeedbackEnabled = true
                setOnClickListener { revealPassword(enterpriseId, row) }
                passwordCells[row] = this
            }

            NAME_COLUMN, COMMENT_COLUMN -> editableCell(enterpriseId, row, column - NAME_COLUMN)
            LAST_CHECKED_COLUMN -> lastCheckedCell(enterpriseId, row)
            else -> resetCell(enterpriseId, row)
        }
    }

    private fun baseTextCell(): TextView {
        return TextView(this).apply {
            gravity = Gravity.CENTER
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            includeFontPadding = false
            isSingleLine = true
            ellipsize = TextUtils.TruncateAt.END
            setPadding(dp(10f), 0, dp(10f), 0)
            setTextIsSelectable(false)
            isLongClickable = false
        }
    }

    private fun idCell(enterpriseId: String, row: Int): View {
        val storedId = cellPrefs.getString(idKey(enterpriseId, row), "").orEmpty()
        val locked = cellPrefs.getBoolean(idLockedKey(enterpriseId, row), false) && storedId.isNotBlank()
        if (locked) {
            return baseTextCell().apply {
                text = storedId
                setTextColor(COLOR_TEXT)
                typeface = Typeface.DEFAULT_BOLD
                background = rounded(COLOR_RESET, COLOR_BORDER, 8)
                contentDescription = "${slotName(row)} locked id"
            }
        }

        return NoCopyEditText(this).apply {
            setSingleLine(true)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(COLOR_TEXT)
            setHintTextColor(COLOR_MUTED)
            gravity = Gravity.CENTER
            includeFontPadding = false
            setPadding(dp(10f), 0, dp(10f), 0)
            background = rounded(COLOR_PANEL, COLOR_BORDER, 8)
            hint = "ID"
            inputType = InputType.TYPE_CLASS_TEXT or
                    InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
                    InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            imeOptions = EditorInfo.IME_ACTION_DONE
            privateImeOptions = "com.google.android.inputmethod.latin.noMicrophoneKey;noPersonalizedLearning"
            filterTouchesWhenObscured = true
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            }
            setText(storedId)
            setOnFocusChangeListener { view, hasFocus ->
                if (!hasFocus) {
                    lockIdIfReady(view as EditText, enterpriseId, row)
                }
            }
            setOnEditorActionListener { view, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_DONE) {
                    lockIdIfReady(view as EditText, enterpriseId, row)
                    true
                } else {
                    false
                }
            }
        }
    }

    private fun lockIdIfReady(cell: EditText, enterpriseId: String, row: Int) {
        val value = cell.text?.toString()?.trim().orEmpty()
        if (value.isBlank()) {
            return
        }
        cellPrefs.edit()
            .putString(idKey(enterpriseId, row), value)
            .putBoolean(idLockedKey(enterpriseId, row), true)
            .apply()
        cell.setText(value)
        cell.isEnabled = false
        cell.alpha = 1f
        cell.clearFocus()
        cell.setTextColor(COLOR_TEXT)
        cell.typeface = Typeface.DEFAULT_BOLD
        cell.background = rounded(COLOR_RESET, COLOR_BORDER, 8)
        Toast.makeText(this, "ID 고정됨", Toast.LENGTH_SHORT).show()
    }

    private fun lastCheckedCell(enterpriseId: String, row: Int): TextView {
        return baseTextCell().apply {
            text = cellPrefs.getString(lastCheckedKey(enterpriseId, row), "Never")
            setTextColor(COLOR_MUTED)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            background = rounded(COLOR_PANEL, COLOR_BORDER, 8)
            contentDescription = "${slotName(row)} last checked time"
            lastCheckedCells[row] = this
        }
    }

    private fun editableCell(enterpriseId: String, row: Int, editableColumn: Int): EditText {
        val key = cellKey(enterpriseId, row, editableColumn)
        return NoCopyEditText(this).apply {
            setSingleLine(true)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(COLOR_TEXT)
            setHintTextColor(COLOR_MUTED)
            gravity = Gravity.CENTER
            includeFontPadding = false
            setPadding(dp(10f), 0, dp(10f), 0)
            background = rounded(COLOR_PANEL, COLOR_BORDER, 8)
            hint = editableHint(editableColumn)
            inputType = InputType.TYPE_CLASS_TEXT or
                    InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
                    InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            privateImeOptions = "com.google.android.inputmethod.latin.noMicrophoneKey;noPersonalizedLearning"
            filterTouchesWhenObscured = true
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            }
            setText(cellPrefs.getString(key, ""))
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                override fun afterTextChanged(s: Editable?) {
                    cellPrefs.edit().putString(key, s?.toString().orEmpty()).apply()
                }
            })
            editableCells[editableColumn][row] = this
        }
    }

    private fun resetCell(enterpriseId: String, row: Int): View {
        val holder = FrameLayout(this).apply {
            background = rounded(COLOR_RESET, COLOR_BORDER, 8)
            filterTouchesWhenObscured = true
        }
        val button = ImageButton(this).apply {
            setImageResource(R.drawable.ic_reset_column)
            setBackgroundColor(Color.TRANSPARENT)
            setColorFilter(COLOR_TEXT)
            contentDescription = "${slotName(row)} 초기화하기"
            tooltipText = "이 행 초기화하기"
            filterTouchesWhenObscured = true
            setOnClickListener { requestRowReset(enterpriseId, row) }
        }
        holder.addView(button, FrameLayout.LayoutParams(dp(46f), dp(46f), Gravity.CENTER))
        return holder
    }

    private fun revealPassword(enterpriseId: String, row: Int) {
        hidePassword(row)
        try {
            if (!vault.hasPassword(enterpriseId, row)) {
                requestNewPassword(enterpriseId, row, clearEditableCells = false)
                return
            }
            val cipher = vault.createDecryptCipher(enterpriseId, row)
            authenticateWithCipher("비밀번호 보기", slotName(row), cipher) { authedCipher ->
                val password = vault.decryptPassword(enterpriseId, row, authedCipher)
                showPassword(enterpriseId, row, password)
            }
        } catch (exception: Exception) {
            showVaultError(exception)
        }
    }

    private fun requestRowReset(enterpriseId: String, row: Int) {
        AlertDialog.Builder(this)
            .setTitle("${slotName(row)} 초기화")
            .setMessage("ID 잠금, Name, COMMENT, Last Checked Time을 비우고 비밀번호를 새로 저장하거나 완전히 삭제합니다.")
            .setPositiveButton("새 비밀번호") { _, _ -> requestNewPassword(enterpriseId, row, clearEditableCells = true) }
            .setNeutralButton("완전 삭제") { _, _ -> deleteRow(enterpriseId, row) }
            .setNegativeButton("취소", null)
            .show()
    }

    private fun requestNewPassword(enterpriseId: String, row: Int, clearEditableCells: Boolean) {
        val input = NoCopyEditText(this).apply {
            hint = "새 비밀번호"
            setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT or
                    InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
                    InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            setPadding(dp(12f), dp(10f), dp(12f), dp(10f))
            background = rounded(Color.WHITE, COLOR_BORDER, 8)
            filterTouchesWhenObscured = true
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            }
        }
        val wrapper = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20f), dp(8f), dp(20f), 0)
            addView(input, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        }

        val dialog = AlertDialog.Builder(this)
            .setTitle("${slotName(row)} 비밀번호 입력")
            .setView(wrapper)
            .setPositiveButton("생체인증 후 저장", null)
            .setNegativeButton("취소", null)
            .create()

        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val password = input.text?.toString().orEmpty()
                if (password.isBlank()) {
                    input.error = "비밀번호를 입력해 주세요"
                    return@setOnClickListener
                }
                dialog.dismiss()
                encryptAndSavePassword(enterpriseId, row, password, clearEditableCells)
            }
        }
        dialog.show()
        dialog.window?.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        input.requestFocus()
    }

    private fun encryptAndSavePassword(
        enterpriseId: String,
        row: Int,
        password: String,
        clearEditableCells: Boolean
    ) {
        try {
            val cipher = vault.createEncryptCipher()
            authenticateWithCipher("비밀번호 저장", slotName(row), cipher) { authedCipher ->
                vault.savePassword(enterpriseId, row, password, authedCipher)
                if (clearEditableCells) {
                    clearEditableCells(enterpriseId, row)
                }
                showPassword(enterpriseId, row, password)
                clearClipboard()
                Toast.makeText(this, "저장 완료", Toast.LENGTH_SHORT).show()
            }
        } catch (exception: Exception) {
            showVaultError(exception)
        }
    }

    private fun deleteRow(enterpriseId: String, row: Int) {
        vault.deletePassword(enterpriseId, row)
        clearEditableCells(enterpriseId, row)
        hidePassword(row)
        clearClipboard()
        Toast.makeText(this, "삭제 완료", Toast.LENGTH_SHORT).show()
    }

    private fun clearEditableCells(enterpriseId: String, row: Int) {
        repeat(EDITABLE_COLUMN_COUNT) { editableColumn ->
            editableCells[editableColumn][row]?.setText("")
            cellPrefs.edit().remove(cellKey(enterpriseId, row, editableColumn)).apply()
        }
        cellPrefs.edit()
            .remove(idKey(enterpriseId, row))
            .remove(idLockedKey(enterpriseId, row))
            .remove(lastCheckedKey(enterpriseId, row))
            .apply()
        lastCheckedCells[row]?.text = "Never"
    }

    private fun authenticateWithCipher(
        title: String,
        subtitle: String,
        cipher: Cipher,
        action: (Cipher) -> Unit
    ) {
        val cancellationSignal = CancellationSignal()
        val prompt = BiometricPrompt.Builder(this)
            .setTitle(title)
            .setSubtitle(subtitle)
            .setNegativeButton("취소", mainExecutor, DialogInterface.OnClickListener { _, _ ->
                cancellationSignal.cancel()
            })
            .build()

        prompt.authenticate(
            BiometricPrompt.CryptoObject(cipher),
            cancellationSignal,
            mainExecutor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    Toast.makeText(this@MainActivity, errString, Toast.LENGTH_SHORT).show()
                }

                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    try {
                        val authedCipher = result.cryptoObject?.cipher
                            ?: throw GeneralSecurityException("Missing authenticated cipher")
                        action(authedCipher)
                    } catch (exception: Exception) {
                        showVaultError(exception)
                    }
                }

                override fun onAuthenticationFailed() {
                    Toast.makeText(this@MainActivity, "인증 실패", Toast.LENGTH_SHORT).show()
                }
            }
        )
    }

    private fun showPassword(enterpriseId: String, row: Int, password: String) {
        val cell = passwordCells[row] ?: return
        hideTasks.remove(row)?.let(handler::removeCallbacks)
        recordLastChecked(enterpriseId, row)
        cell.text = password
        cell.setTextColor(Color.rgb(21, 128, 61))
        cell.typeface = Typeface.MONOSPACE
        cell.background = rounded(COLOR_PASSWORD_REVEALED, Color.rgb(134, 239, 172), 8)
        cell.contentDescription = "${slotName(row)} password revealed"

        val hideTask = Runnable { hidePassword(row) }
        hideTasks[row] = hideTask
        handler.postDelayed(hideTask, REVEAL_MS)
    }

    private fun recordLastChecked(enterpriseId: String, row: Int) {
        val timestamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.getDefault()).format(Date())
        cellPrefs.edit().putString(lastCheckedKey(enterpriseId, row), timestamp).apply()
        lastCheckedCells[row]?.text = timestamp
    }

    private fun hidePassword(row: Int) {
        hideTasks.remove(row)?.let(handler::removeCallbacks)
        val cell = passwordCells[row] ?: return
        cell.text = MASK
        cell.setTextColor(COLOR_TEXT)
        cell.typeface = Typeface.MONOSPACE
        cell.background = rounded(COLOR_PASSWORD, COLOR_BORDER, 8)
        cell.contentDescription = "${slotName(row)} password"
    }

    private fun maskAllPasswords() {
        repeat(ENTRY_COUNT) { hidePassword(it) }
    }

    private fun clearClipboard() {
        runCatching {
            val clipboardManager = getSystemService(CLIPBOARD_SERVICE) as? ClipboardManager
            clipboardManager?.setPrimaryClip(ClipData.newPlainText("", ""))
        }
    }

    private fun showVaultError(exception: Exception) {
        val message = when {
            exception is KeyPermanentlyInvalidatedException -> "생체 정보 변경으로 키가 무효화됨"
            exception is IllegalStateException && exception.message != null -> exception.message.orEmpty()
            else -> "Keystore 작업 실패"
        }
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }

    private fun editableHint(editableColumn: Int): String {
        return when (editableColumn) {
            0 -> "Name"
            else -> "COMMENT"
        }
    }

    private fun cellKey(enterpriseId: String, row: Int, editableColumn: Int): String {
        return "e_${enterpriseId}_r${row}_m${editableColumn}"
    }

    private fun idKey(enterpriseId: String, row: Int): String {
        return "e_${enterpriseId}_r${row}_id"
    }

    private fun idLockedKey(enterpriseId: String, row: Int): String {
        return "e_${enterpriseId}_r${row}_id_locked"
    }

    private fun lastCheckedKey(enterpriseId: String, row: Int): String {
        return "e_${enterpriseId}_r${row}_last_checked"
    }

    private fun slotName(row: Int) = String.format(Locale.US, "Slot %02d", row + 1)

    private fun rounded(fill: Int, stroke: Int, radiusDp: Int): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            setColor(fill)
            setStroke(dp(1f), stroke)
            cornerRadius = dp(radiusDp.toFloat()).toFloat()
        }
    }

    private fun dp(value: Float): Int {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value,
            resources.displayMetrics
        ).toInt()
    }

    private data class Enterprise(val id: String, val name: String)

    private class EnterpriseStore(context: Context) {
        private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        fun listEnterprises(): List<Enterprise> {
            return ids().map { id -> Enterprise(id, nameOf(id)) }
        }

        fun addEnterprise(name: String): Enterprise {
            val existingIds = ids()
            val id = "enterprise_${System.currentTimeMillis()}_${existingIds.size}"
            prefs.edit()
                .putString(KEY_IDS, (existingIds + id).joinToString("\n"))
                .putString(nameKey(id), name)
                .apply()
            return Enterprise(id, name)
        }

        fun nameOf(id: String): String {
            return prefs.getString(nameKey(id), null)?.takeIf { it.isNotBlank() } ?: "Enterprise"
        }

        private fun ids(): List<String> {
            return prefs.getString(KEY_IDS, "")
                .orEmpty()
                .split('\n')
                .map { it.trim() }
                .filter { it.isNotEmpty() }
        }

        private fun nameKey(id: String) = "name_$id"

        companion object {
            private const val PREFS_NAME = "enterprises"
            private const val KEY_IDS = "enterprise_ids"
        }
    }

    private class PasswordVault(context: Context) {
        private val appContext = context.applicationContext
        private val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        fun hasPassword(enterpriseId: String, row: Int): Boolean {
            return prefs.contains(cipherKey(enterpriseId, row)) && prefs.contains(ivKey(enterpriseId, row))
        }

        @Throws(GeneralSecurityException::class, IOException::class)
        fun createEncryptCipher(): Cipher {
            return Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            }
        }

        @Throws(GeneralSecurityException::class, IOException::class)
        fun createDecryptCipher(enterpriseId: String, row: Int): Cipher {
            val encodedIv = prefs.getString(ivKey(enterpriseId, row), null)
                ?: throw IllegalStateException("저장된 비밀번호 없음")
            val iv = Base64.decode(encodedIv, Base64.NO_WRAP)
            return Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
            }
        }

        @Throws(GeneralSecurityException::class)
        fun savePassword(enterpriseId: String, row: Int, password: String, authenticatedCipher: Cipher) {
            val plaintext = password.toByteArray(StandardCharsets.UTF_8)
            try {
                val ciphertext = authenticatedCipher.doFinal(plaintext)
                val iv = authenticatedCipher.iv ?: throw GeneralSecurityException("Missing GCM IV")
                prefs.edit()
                    .putString(cipherKey(enterpriseId, row), Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                    .putString(ivKey(enterpriseId, row), Base64.encodeToString(iv, Base64.NO_WRAP))
                    .apply()
            } finally {
                plaintext.fill(0)
            }
        }

        @Throws(GeneralSecurityException::class)
        fun decryptPassword(enterpriseId: String, row: Int, authenticatedCipher: Cipher): String {
            val encodedCiphertext = prefs.getString(cipherKey(enterpriseId, row), null)
                ?: throw IllegalStateException("저장된 비밀번호 없음")
            val ciphertext = Base64.decode(encodedCiphertext, Base64.NO_WRAP)
            val plaintext = authenticatedCipher.doFinal(ciphertext)
            return try {
                String(plaintext, StandardCharsets.UTF_8)
            } finally {
                plaintext.fill(0)
            }
        }

        fun deletePassword(enterpriseId: String, row: Int) {
            prefs.edit()
                .remove(cipherKey(enterpriseId, row))
                .remove(ivKey(enterpriseId, row))
                .apply()
        }

        @Throws(GeneralSecurityException::class, IOException::class)
        private fun getOrCreateKey(): SecretKey {
            val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
            if (!keyStore.containsAlias(KEY_ALIAS)) {
                val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
                val builder = KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .setUserAuthenticationRequired(true)
                    .setInvalidatedByBiometricEnrollment(true)

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                } else {
                    @Suppress("DEPRECATION")
                    builder.setUserAuthenticationValidityDurationSeconds(-1)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    builder.setUnlockedDeviceRequired(true)
                }

                keyGenerator.init(builder.build())
                keyGenerator.generateKey()
            }
            return keyStore.getKey(KEY_ALIAS, null) as SecretKey
        }

        private fun cipherKey(enterpriseId: String, row: Int) = "c_${enterpriseId}_r$row"

        private fun ivKey(enterpriseId: String, row: Int) = "iv_${enterpriseId}_r$row"

        companion object {
            private const val PREFS_NAME = "encrypted_enterprise_passwords"
            private const val KEY_ALIAS = "password-storage-per-use-biometric-v2"
            private const val ANDROID_KEYSTORE = "AndroidKeyStore"
            private const val TRANSFORMATION = "AES/GCM/NoPadding"
            private const val GCM_TAG_BITS = 128
        }
    }

    private class NoCopyEditText(context: Context) : EditText(context) {
        init {
            isLongClickable = false
            setTextIsSelectable(false)
            customSelectionActionModeCallback = object : ActionMode.Callback {
                override fun onCreateActionMode(mode: ActionMode?, menu: Menu?): Boolean {
                    menu?.clear()
                    return false
                }

                override fun onPrepareActionMode(mode: ActionMode?, menu: Menu?): Boolean {
                    menu?.clear()
                    return false
                }

                override fun onActionItemClicked(mode: ActionMode?, item: MenuItem?): Boolean = true

                override fun onDestroyActionMode(mode: ActionMode?) = Unit
            }
        }

        override fun performLongClick(): Boolean = false

        override fun onTextContextMenuItem(id: Int): Boolean {
            return when (id) {
                android.R.id.copy,
                android.R.id.cut,
                android.R.id.paste,
                android.R.id.pasteAsPlainText -> true
                else -> super.onTextContextMenuItem(id)
            }
        }

        override fun isSuggestionsEnabled(): Boolean = false
    }

    companion object {
        private const val TABLE_COLUMN_COUNT = 7
        private const val ENTRY_COUNT = 40
        private const val SLOT_COLUMN = 0
        private const val ID_COLUMN = 1
        private const val PASSWORD_COLUMN = 2
        private const val NAME_COLUMN = 3
        private const val COMMENT_COLUMN = 4
        private const val LAST_CHECKED_COLUMN = 5
        private const val RESET_COLUMN = 6
        private const val EDITABLE_COLUMN_COUNT = 2
        private const val CELL_HEIGHT_DP = 58
        private const val REVEAL_MS = 15_000L
        private const val MASK = "----------"

        private val CELL_WIDTHS_DP = intArrayOf(96, 150, 156, 140, 220, 186, 74)
        private val columnLabels = listOf("Slot", "ID", "Password", "Name", "COMMENT", "Last Checked Time", "RESET")

        private val COLOR_BG = Color.rgb(7, 7, 14)
        private val COLOR_PANEL = Color.rgb(17, 16, 29)
        private val COLOR_HEADER = Color.rgb(245, 247, 250)
        private val COLOR_HEADER_TEXT = Color.rgb(245, 247, 250)
        private val COLOR_BORDER = Color.rgb(33, 32, 49)
        private val COLOR_PASSWORD = Color.rgb(20, 26, 46)
        private val COLOR_PASSWORD_REVEALED = Color.rgb(18, 66, 48)
        private val COLOR_RESET = Color.rgb(22, 22, 34)
        private val COLOR_TEXT = Color.rgb(235, 238, 245)
        private val COLOR_MUTED = Color.rgb(125, 132, 150)
        private val COLOR_ACCENT = Color.rgb(83, 91, 242)
    }
}
