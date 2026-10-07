package com.autoaim.app

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val prefs = getSharedPreferences("autoaim", MODE_PRIVATE)
        val pad = (24 * resources.displayMetrics.density).toInt()

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#0A101C"))
            setPadding(pad, pad, pad, pad)
        }

        val title = TextView(this).apply {
            text = "🎯 AutoAim Master V16"
            setTextColor(Color.parseColor("#00FFAA"))
            textSize = 24f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
        }

        val urlInput = EditText(this).apply {
            hint = "URL game (https://...)"
            setText(prefs.getString("url", ""))
            setTextColor(Color.WHITE)
            setHintTextColor(Color.GRAY)
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine(true)
        }

        val openBtn = Button(this).apply {
            text = "Open Game"
            setOnClickListener {
                var url = urlInput.text.toString().trim()
                if (url.isEmpty()) {
                    Toast.makeText(this@MainActivity, "Isi URL game dulu", Toast.LENGTH_SHORT).show()
                    return@setOnClickListener
                }
                if (!url.startsWith("http://") && !url.startsWith("https://")) url = "https://$url"
                prefs.edit().putString("url", url).apply()
                startActivity(Intent(this@MainActivity, GameActivity::class.java).putExtra("url", url))
            }
        }

        root.addView(title)
        root.addView(urlInput, LinearLayout.LayoutParams(-1, -2).apply { topMargin = pad })
        root.addView(openBtn, LinearLayout.LayoutParams(-1, -2).apply { topMargin = pad / 2 })
        setContentView(root)
    }
}
