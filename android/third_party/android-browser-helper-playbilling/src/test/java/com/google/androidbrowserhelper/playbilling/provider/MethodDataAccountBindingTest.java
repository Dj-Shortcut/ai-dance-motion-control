package com.google.androidbrowserhelper.playbilling.provider;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import android.content.Intent;
import android.os.Bundle;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.Collections;

/** Exercises actual JSON/Intent parsing, without a store, account or payment. */
@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public final class MethodDataAccountBindingTest {
    private static final String ACCOUNT = "a1".repeat(32);
    private static final String BILLING = "https://play.google.com/billing";

    private static String json(Object account) throws Exception {
        return new JSONObject().put("sku", "rig_credit_5")
                .put("obfuscatedAccountId", account).toString();
    }

    private static Intent intent(String methodJson) {
        Bundle methods = new Bundle();
        methods.putString(BILLING, methodJson);
        return new Intent().putStringArrayListExtra("methodNames",
                new ArrayList<>(Collections.singletonList(BILLING)))
                .putExtra("methodData", methods);
    }

    @Test
    public void forwardsExactServerBindingFromMethodData() throws Exception {
        MethodData data = MethodData.fromIntent(intent(json(ACCOUNT)));
        assertNotNull(data);
        assertEquals("rig_credit_5", data.sku);
        assertEquals(ACCOUNT, data.obfuscatedAccountId);
    }

    @Test
    public void missingBindingIsRejectedBeforeAStoreCanBeOpened() {
        assertNull(MethodData.fromJson("{\"sku\":\"rig_credit_5\"}"));
    }

    @Test
    public void wrongTypesAreRejectedRatherThanCoercedToAnAccountId() throws Exception {
        for (Object value : new Object[]{JSONObject.NULL, true, 123,
                new JSONObject(), new org.json.JSONArray()}) {
            assertNull(MethodData.fromJson(json(value)));
        }
    }

    @Test
    public void malformedOpaqueIdsAreRejected() throws Exception {
        for (String value : new String[]{"", "a".repeat(63), "a".repeat(65),
                "A".repeat(64), "g".repeat(64), "a".repeat(63) + " ",
                "a".repeat(63) + "\n", "a".repeat(63) + "é"}) {
            assertNull("Accepted malformed account ID", MethodData.fromJson(json(value)));
        }
    }

    @Test
    public void topLevelIntentExtrasCannotProvideOrReplaceTheBinding() throws Exception {
        Intent missing = intent("{\"sku\":\"rig_credit_5\"}");
        missing.putExtra("obfuscatedAccountId", ACCOUNT);
        missing.putExtra("accountId", ACCOUNT);
        assertNull(MethodData.fromIntent(missing));

        Intent valid = intent(json(ACCOUNT));
        valid.putExtra("obfuscatedAccountId", "b".repeat(64));
        valid.putExtra("accountId", "c".repeat(64));
        assertEquals(ACCOUNT, MethodData.fromIntent(valid).obfuscatedAccountId);
    }

    @Test
    public void incompleteOrInvalidMethodDataIsRejected() {
        assertNull(MethodData.fromIntent(new Intent()));
        assertNull(MethodData.fromIntent(intent("not json")));
        assertNull(MethodData.fromJson("{\"obfuscatedAccountId\":\"" + ACCOUNT + "\"}"));
    }
}
