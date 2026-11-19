package dev.andyarijs.rig;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import com.google.androidbrowserhelper.trusted.LauncherActivity;
import com.google.androidbrowserhelper.trusted.TwaLauncher;

/** Starts only RIG's Android channel, using the browser's existing web security. */
public final class RigLauncherActivity extends LauncherActivity {
    static final String LAUNCH_URL =
            "https://rig-motion-studio.shortcutcomputerguy.chatgpt.site/android/";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // LauncherActivity also inspects share/file extras, not just getLaunchingUrl().
        // Build a fresh Intent before its lifecycle starts; never copy caller extras,
        // ClipData, grants, browser packages, selectors or data URIs into that code.
        setIntent(cleanLaunchIntent());
        super.onCreate(savedInstanceState);
    }

    private Intent cleanLaunchIntent() {
        return new Intent(Intent.ACTION_MAIN)
                .setClass(this, RigLauncherActivity.class)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    }

    @Override
    protected void onNewIntent(Intent ignored) {
        Intent clean = cleanLaunchIntent();
        setIntent(clean);
        super.onNewIntent(clean);
    }

    @Override
    protected Uri getLaunchingUrl() {
        return Uri.parse(LAUNCH_URL);
    }

    @Override
    protected Uri getUrlForIntent(Intent ignored) {
        // Prevent ABH from forwarding an "original launch URL" to the browser.
        return null;
    }

    @Override
    protected TwaLauncher.FallbackStrategy getFallbackStrategy() {
        // An unverified origin keeps the visible browser bar; no WebView or trust bypass.
        return TwaLauncher.CCT_FALLBACK_STRATEGY;
    }
}
