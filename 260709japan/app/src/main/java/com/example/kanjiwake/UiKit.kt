package com.example.kanjiwake

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView

object KwColor {
    val Ink: Int = Color.rgb(23, 33, 38)
    val Muted: Int = Color.rgb(91, 102, 103)
    val Paper: Int = Color.rgb(244, 247, 246)
    val Surface: Int = Color.WHITE
    val Input: Int = Color.rgb(249, 250, 250)
    val Line: Int = Color.rgb(211, 219, 216)
    val Teal: Int = Color.rgb(20, 125, 114)
    val Saffron: Int = Color.rgb(224, 161, 27)
    val Plum: Int = Color.rgb(122, 48, 80)
    val Bad: Int = Color.rgb(176, 47, 53)
    val Good: Int = Color.rgb(26, 126, 76)
    val GoodSurface: Int = Color.rgb(232, 246, 238)
    val WarningSurface: Int = Color.rgb(255, 246, 220)
    val BadSurface: Int = Color.rgb(252, 235, 236)
}

fun Context.dp(value: Int): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

fun Context.rounded(
    fill: Int,
    radiusDp: Int,
    strokeColor: Int? = null,
    strokeWidthDp: Int = 1
): GradientDrawable {
    return GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(radiusDp).toFloat()
        strokeColor?.let { setStroke(dp(strokeWidthDp), it) }
    }
}

fun TextView.kwText(
    sizeSp: Float,
    color: Int = KwColor.Ink,
    bold: Boolean = false,
    lineSpacingExtraDp: Int = 0
) {
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
    setTextColor(color)
    includeFontPadding = true
    if (bold) typeface = Typeface.DEFAULT_BOLD
    if (lineSpacingExtraDp > 0) {
        setLineSpacing(context.dp(lineSpacingExtraDp).toFloat(), 1.0f)
    }
}

fun Button.kwButton(
    fill: Int,
    textColor: Int,
    strokeColor: Int? = null,
    compact: Boolean = false
) {
    isAllCaps = false
    minHeight = context.dp(if (compact) 38 else 54)
    minimumHeight = context.dp(if (compact) 38 else 54)
    setTextColor(textColor)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, if (compact) 13f else 16f)
    typeface = Typeface.DEFAULT_BOLD
    background = context.rounded(fill, radiusDp = 8, strokeColor = strokeColor)
    setPadding(context.dp(14), context.dp(8), context.dp(14), context.dp(8))
}

fun View.setMargins(left: Int = 0, top: Int = 0, right: Int = 0, bottom: Int = 0) {
    val params = layoutParams as? ViewGroup.MarginLayoutParams ?: return
    params.setMargins(left, top, right, bottom)
    layoutParams = params
}
