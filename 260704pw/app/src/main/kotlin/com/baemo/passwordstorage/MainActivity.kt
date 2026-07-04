package com.baemo.passwordstorage

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
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
import java.nio.charset.StandardCharsets
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.util.Locale
import java.util.concurrent.Executor
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class MainActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private val mainExecutor = Executor { command -> handler.post(command) }
    private val passwordCells = arrayOfNulls<TextView>(COLUMN_COUNT)
    private val editableCells = Array(EDITABLE_ROW_COUNT) { arrayOfNulls<EditText>(COLUMN_COUNT) }
    private val hideTasks = mutableMapOf<Int, Runnable>()

    private lateinit var vault: PasswordVault
    private lateinit var metadataPrefs: android.content.SharedPreferences

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            setRecentsScreenshotEnabled(false)
        }

        vault = PasswordVault(this)
        metadataPrefs = getSharedPreferences("column_metadata", MODE_PRIVATE)
        setContentView(createContent())
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

    private fun createContent(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(COLOR_BG)
            setPadding(dp(18f), dp(16f), dp(18f), dp(14f))
            filterTouchesWhenObscured = true
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        val title = TextView(this).apply {
            text = "Password Storage"
            setTextColor(COLOR_HEADER)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
            typeface = Typeface.DEFAULT_BOLD
            isSingleLine = true
            ellipsize = TextUtils.TruncateAt.END
        }
        header.addView(title, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))

        val shape = TextView(this).apply {
            text = "40 x 6"
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
            ).apply { setMargins(0, 0, 0, dp(12f)) }
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

        val table = TableLayout(this).apply {
            isShrinkAllColumns = false
            isStretchAllColumns = false
            setBackgroundColor(COLOR_BG)
            filterTouchesWhenObscured = true
        }

        repeat(ROW_COUNT) { row ->
            val tableRow = TableRow(this).apply {
                gravity = Gravity.CENTER_VERTICAL
                isBaselineAligned = false
            }
            repeat(COLUMN_COUNT) { column ->
                tableRow.addView(createCell(row, column), cellParams(row))
            }
            table.addView(
                tableRow,
                TableLayout.LayoutParams(
                    TableLayout.LayoutParams.WRAP_CONTENT,
                    TableLayout.LayoutParams.WRAP_CONTENT
                )
            )
        }

        horizontalScroll.addView(
            table,
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
        root.addView(
            verticalScroll,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f)
        )

        return root
    }

    private fun cellParams(row: Int): TableRow.LayoutParams {
        val height = if (row == RESET_ROW) RESET_HEIGHT_DP else CELL_HEIGHT_DP
        return TableRow.LayoutParams(dp(CELL_WIDTH_DP.toFloat()), dp(height.toFloat())).apply {
            setMargins(dp(3f), dp(3f), dp(3f), dp(3f))
        }
    }

    private fun createCell(row: Int, column: Int): View {
        return when (row) {
            HEADER_ROW -> baseTextCell().apply {
                text = slotName(column)
                setTextColor(COLOR_HEADER_TEXT)
                typeface = Typeface.DEFAULT_BOLD
                background = rounded(COLOR_HEADER, COLOR_HEADER, 8)
            }

            PASSWORD_ROW -> baseTextCell().apply {
                text = MASK
                setTextColor(COLOR_TEXT)
                typeface = Typeface.MONOSPACE
                background = rounded(COLOR_PASSWORD, COLOR_BORDER, 8)
                contentDescription = "${slotName(column)} password"
                filterTouchesWhenObscured = true
                isHapticFeedbackEnabled = true
                setOnClickListener { revealPassword(column) }
                passwordCells[column] = this
            }

            in EDITABLE_ROWS -> editableCell(row - EDITABLE_START_ROW, column)
            else -> resetCell(column)
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

    private fun editableCell(editableRow: Int, column: Int): EditText {
        val key = metadataKey(editableRow, column)
        return NoCopyEditText(this).apply {
            setSingleLine(true)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(COLOR_TEXT)
            setHintTextColor(COLOR_MUTED)
            gravity = Gravity.CENTER
            includeFontPadding = false
            setPadding(dp(10f), 0, dp(10f), 0)
            background = rounded(COLOR_PANEL, COLOR_BORDER, 8)
            hint = editableHint(editableRow)
            inputType = InputType.TYPE_CLASS_TEXT or
                    InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
                    InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            privateImeOptions = "com.google.android.inputmethod.latin.noMicrophoneKey;noPersonalizedLearning"
            filterTouchesWhenObscured = true
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            }
            setText(metadataPrefs.getString(key, ""))
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                override fun afterTextChanged(s: Editable?) {
                    metadataPrefs.edit().putString(key, s?.toString().orEmpty()).apply()
                }
            })
            editableCells[editableRow][column] = this
        }
    }

    private fun resetCell(column: Int): View {
        val holder = FrameLayout(this).apply {
            background = rounded(COLOR_RESET, COLOR_BORDER, 8)
            filterTouchesWhenObscured = true
        }
        val button = ImageButton(this).apply {
            setImageResource(R.drawable.ic_reset_column)
            setBackgroundColor(Color.TRANSPARENT)
            setColorFilter(COLOR_TEXT)
            contentDescription = "이 열 초기화하기"
            tooltipText = "이 열 초기화하기"
            filterTouchesWhenObscured = true
            setOnClickListener { requestColumnReset(column) }
        }
        holder.addView(button, FrameLayout.LayoutParams(dp(48f), dp(48f), Gravity.CENTER))
        return holder
    }

    private fun revealPassword(column: Int) {
        hidePassword(column)
        try {
            if (!vault.hasColumn(column)) {
                requestNewPassword(column, clearEditableRows = false)
                return
            }
            val cipher = vault.createDecryptCipher(column)
            authenticateWithCipher("비밀번호 보기", slotName(column), cipher) { authedCipher ->
                val password = vault.decryptColumn(column, authedCipher)
                showPassword(column, password)
            }
        } catch (exception: Exception) {
            showVaultError(exception)
        }
    }

    private fun requestColumnReset(column: Int) {
        AlertDialog.Builder(this)
            .setTitle("${slotName(column)} 초기화")
            .setMessage("3-5행을 비우고 2행 비밀번호를 새 평문 값으로 다시 저장합니다.")
            .setPositiveButton("새 비밀번호") { _, _ -> requestNewPassword(column, clearEditableRows = true) }
            .setNeutralButton("완전 삭제") { _, _ -> deleteColumn(column) }
            .setNegativeButton("취소", null)
            .show()
    }

    private fun requestNewPassword(column: Int, clearEditableRows: Boolean) {
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
            .setTitle("${slotName(column)} 비밀번호 입력")
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
                encryptAndSavePassword(column, password, clearEditableRows)
            }
        }
        dialog.show()
        dialog.window?.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        input.requestFocus()
    }

    private fun encryptAndSavePassword(column: Int, password: String, clearEditableRows: Boolean) {
        try {
            val cipher = vault.createEncryptCipher()
            authenticateWithCipher("비밀번호 저장", slotName(column), cipher) { authedCipher ->
                vault.saveColumn(column, password, authedCipher)
                if (clearEditableRows) {
                    clearEditableRows(column)
                }
                showPassword(column, password)
                clearClipboard()
                Toast.makeText(this, "저장 완료", Toast.LENGTH_SHORT).show()
            }
        } catch (exception: Exception) {
            showVaultError(exception)
        }
    }

    private fun deleteColumn(column: Int) {
        vault.deleteColumn(column)
        clearEditableRows(column)
        hidePassword(column)
        clearClipboard()
        Toast.makeText(this, "삭제 완료", Toast.LENGTH_SHORT).show()
    }

    private fun clearEditableRows(column: Int) {
        repeat(EDITABLE_ROW_COUNT) { editableRow ->
            editableCells[editableRow][column]?.setText("")
            metadataPrefs.edit().remove(metadataKey(editableRow, column)).apply()
        }
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

    private fun showPassword(column: Int, password: String) {
        val cell = passwordCells[column] ?: return
        hideTasks.remove(column)?.let(handler::removeCallbacks)
        cell.text = password
        cell.setTextColor(Color.rgb(21, 128, 61))
        cell.typeface = Typeface.MONOSPACE
        cell.background = rounded(COLOR_PASSWORD_REVEALED, Color.rgb(134, 239, 172), 8)
        cell.contentDescription = "${slotName(column)} password revealed"

        val hideTask = Runnable { hidePassword(column) }
        hideTasks[column] = hideTask
        handler.postDelayed(hideTask, REVEAL_MS)
    }

    private fun hidePassword(column: Int) {
        hideTasks.remove(column)?.let(handler::removeCallbacks)
        val cell = passwordCells[column] ?: return
        cell.text = MASK
        cell.setTextColor(COLOR_TEXT)
        cell.typeface = Typeface.MONOSPACE
        cell.background = rounded(COLOR_PASSWORD, COLOR_BORDER, 8)
        cell.contentDescription = "${slotName(column)} password"
    }

    private fun maskAllPasswords() {
        repeat(COLUMN_COUNT) { hidePassword(it) }
    }

    private fun clearClipboard() {
        runCatching {
            val clipboardManager = getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager
            clipboardManager.setPrimaryClip(ClipData.newPlainText("", ""))
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

    private fun editableHint(editableRow: Int): String {
        return when (editableRow) {
            0 -> "ID"
            1 -> "Name"
            else -> "Memo"
        }
    }

    private fun metadataKey(editableRow: Int, column: Int) = "r${editableRow}_c${column}"

    private fun slotName(column: Int) = String.format(Locale.US, "Slot %02d", column + 1)

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

    private class PasswordVault(context: Context) {
        private val appContext = context.applicationContext
        private val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

        fun hasColumn(column: Int): Boolean {
            return prefs.contains(cipherKey(column)) && prefs.contains(ivKey(column))
        }

        @Throws(GeneralSecurityException::class, IOException::class)
        fun createEncryptCipher(): Cipher {
            return Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            }
        }

        @Throws(GeneralSecurityException::class, IOException::class)
        fun createDecryptCipher(column: Int): Cipher {
            val encodedIv = prefs.getString(ivKey(column), null)
                ?: throw IllegalStateException("저장된 비밀번호 없음")
            val iv = Base64.decode(encodedIv, Base64.NO_WRAP)
            return Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
            }
        }

        @Throws(GeneralSecurityException::class)
        fun saveColumn(column: Int, password: String, authenticatedCipher: Cipher) {
            val plaintext = password.toByteArray(StandardCharsets.UTF_8)
            try {
                val ciphertext = authenticatedCipher.doFinal(plaintext)
                val iv = authenticatedCipher.iv ?: throw GeneralSecurityException("Missing GCM IV")
                prefs.edit()
                    .putString(cipherKey(column), Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                    .putString(ivKey(column), Base64.encodeToString(iv, Base64.NO_WRAP))
                    .apply()
            } finally {
                plaintext.fill(0)
            }
        }

        @Throws(GeneralSecurityException::class)
        fun decryptColumn(column: Int, authenticatedCipher: Cipher): String {
            val encodedCiphertext = prefs.getString(cipherKey(column), null)
                ?: throw IllegalStateException("저장된 비밀번호 없음")
            val ciphertext = Base64.decode(encodedCiphertext, Base64.NO_WRAP)
            val plaintext = authenticatedCipher.doFinal(ciphertext)
            return try {
                String(plaintext, StandardCharsets.UTF_8)
            } finally {
                plaintext.fill(0)
            }
        }

        fun deleteColumn(column: Int) {
            prefs.edit()
                .remove(cipherKey(column))
                .remove(ivKey(column))
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

        private fun cipherKey(column: Int) = "c_$column"

        private fun ivKey(column: Int) = "iv_$column"

        companion object {
            private const val PREFS_NAME = "encrypted_password_columns"
            private const val KEY_ALIAS = "password-storage-per-use-biometric-v1"
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
        private const val COLUMN_COUNT = 40
        private const val ROW_COUNT = 6
        private const val HEADER_ROW = 0
        private const val PASSWORD_ROW = 1
        private const val EDITABLE_START_ROW = 2
        private const val RESET_ROW = 5
        private val EDITABLE_ROWS = 2..4
        private const val EDITABLE_ROW_COUNT = 3
        private const val CELL_WIDTH_DP = 148
        private const val CELL_HEIGHT_DP = 58
        private const val RESET_HEIGHT_DP = 62
        private const val REVEAL_MS = 15_000L
        private const val MASK = "----------"

        private val COLOR_BG = Color.rgb(247, 245, 240)
        private val COLOR_PANEL = Color.rgb(255, 255, 255)
        private val COLOR_HEADER = Color.rgb(15, 23, 42)
        private val COLOR_HEADER_TEXT = Color.rgb(248, 250, 252)
        private val COLOR_BORDER = Color.rgb(226, 232, 240)
        private val COLOR_PASSWORD = Color.rgb(232, 240, 254)
        private val COLOR_PASSWORD_REVEALED = Color.rgb(220, 252, 231)
        private val COLOR_RESET = Color.rgb(241, 245, 249)
        private val COLOR_TEXT = Color.rgb(30, 41, 59)
        private val COLOR_MUTED = Color.rgb(100, 116, 139)
    }
}
