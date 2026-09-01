package com.stella.cloudbrowsersession

import android.webkit.CookieManager
import androidx.webkit.CookieManagerCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.URI
import java.net.URISyntaxException
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.Locale

private const val MAXIMUM_COOKIES = 128
private const val MAXIMUM_BYTES = 32 * 1024

class StellaCloudBrowserSessionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("StellaCloudBrowserSession")

    Function("isCaptureAvailable") {
      WebViewFeature.isFeatureSupported(WebViewFeature.GET_COOKIE_INFO)
    }

    AsyncFunction("captureCookies") Coroutine { rawUrl: String ->
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.GET_COOKIE_INFO)) {
        throw CaptureUnavailableException()
      }
      val uri = validatedHttpsUri(rawUrl)
      val rawCookies = CookieManagerCompat.getCookieInfo(CookieManager.getInstance(), uri.toString())
      val nowEpochSeconds = Instant.now().epochSecond
      var totalBytes = 0
      val result = mutableListOf<Map<String, Any>>()

      rawCookies.forEach { rawCookie ->
        val cookie = CloudBrowserCookieParser.parse(rawCookie, uri, nowEpochSeconds)
          ?: return@forEach
        if (result.size >= MAXIMUM_COOKIES) throw SessionTooLargeException()
        totalBytes += listOf(
          cookie.name,
          cookie.value,
          cookie.domain,
          cookie.path,
          cookie.sameSite,
        ).sumOf { field -> field.toByteArray(StandardCharsets.UTF_8).size }
        if (totalBytes > MAXIMUM_BYTES) throw SessionTooLargeException()
        result.add(cookie.toMap())
      }
      result
    }
  }

  private fun validatedHttpsUri(rawUrl: String): URI {
    val uri = try {
      URI(rawUrl)
    } catch (_: URISyntaxException) {
      throw InvalidOriginException()
    }
    if (
      uri.scheme?.lowercase(Locale.US) != "https" ||
      uri.host.isNullOrBlank() ||
      uri.userInfo != null
    ) {
      throw InvalidOriginException()
    }
    return uri
  }
}

private class InvalidOriginException : CodedException(
  "invalid_origin",
  "A valid HTTPS URL is required.",
  null,
)

private class CaptureUnavailableException : CodedException(
  "capture_unavailable",
  "This Android WebView cannot export complete cookie attributes.",
  null,
)

private class SessionTooLargeException : CodedException(
  "session_too_large",
  "The site session is too large to transfer.",
  null,
)
