package com.google.androidbrowserhelper.playbilling.provider;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import android.app.Activity;

import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.ProductDetails;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.util.ReflectionHelpers;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Captures the real SDK request without connecting to Google or charging money. */
@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 28)
public final class PlayBillingAccountBindingTest {
    private Activity activity;
    private BillingClient client;
    private ProductDetails product;
    private PlayBillingWrapper wrapper;

    @Before
    public void setUp() {
        activity = Robolectric.buildActivity(Activity.class).create().get();
        client = mock(BillingClient.class);
        wrapper = new PlayBillingWrapper((result, token) -> {
            throw new AssertionError("No purchase callback is expected in this isolated test");
        }, client);
        product = ReflectionHelpers.callConstructor(ProductDetails.class,
                ReflectionHelpers.ClassParameter.from(String.class,
                        "{\"productId\":\"rig_credit_5\",\"type\":\"inapp\","
                        + "\"title\":\"RIG credit\",\"name\":\"RIG credit\","
                        + "\"description\":\"Test\",\"skuDetailsToken\":\"fixture\","
                        + "\"oneTimePurchaseOfferDetails\":{\"formattedPrice\":\"€5.00\","
                        + "\"priceAmountMicros\":5000000,\"priceCurrencyCode\":\"EUR\"}}"));
    }

    @Test
    public void actualBillingFlowParamsCarryTheExactGoogleAccountField() throws Exception {
        String account = "b2".repeat(32);
        MethodData method = MethodData.fromJson(new JSONObject().put("sku", "rig_credit_5")
                .put("obfuscatedAccountId", account).toString());
        when(client.launchBillingFlow(eq(activity), any(BillingFlowParams.class)))
                .thenReturn(BillingResult.newBuilder()
                        .setResponseCode(BillingClient.BillingResponseCode.OK).build());

        assertTrue(wrapper.launchPaymentFlow(activity, product, method));
        ArgumentCaptor<BillingFlowParams> capture = ArgumentCaptor.forClass(BillingFlowParams.class);
        verify(client).launchBillingFlow(eq(activity), capture.capture());

        // Google's SDK obfuscates its getter/field names. Derive the account
        // field from a real reference builder, then check the captured request.
        // This fails for omission OR accidental setObfuscatedProfileId usage.
        BillingFlowParams reference = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(Collections.singletonList(
                        BillingFlowParams.ProductDetailsParams.newBuilder()
                                .setProductDetails(product).build()))
                .setObfuscatedAccountId(account).build();
        List<Field> accountFields = new ArrayList<>();
        for (Field field : BillingFlowParams.class.getDeclaredFields()) {
            if (field.getType() != String.class) continue;
            field.setAccessible(true);
            if (account.equals(field.get(reference))) accountFields.add(field);
        }
        assertFalse("The pinned SDK must expose its stored account binding", accountFields.isEmpty());
        for (Field field : accountFields) {
            assertEquals(account, field.get(capture.getValue()));
        }
    }

    @Test
    public void absentOrRejectedMethodNeverCallsTheStore() {
        assertFalse(wrapper.launchPaymentFlow(activity, product, null));
        assertFalse(wrapper.launchPaymentFlow(activity, product,
                MethodData.fromJson("{\"sku\":\"rig_credit_5\"}")));
        assertFalse(wrapper.launchPaymentFlow(activity, product,
                MethodData.fromJson("{\"sku\":\"rig_credit_5\",\"obfuscatedAccountId\":\"bad\"}")));
        verifyNoInteractions(client);
    }
}
