package com.stella.cloudbrowsersession

import java.net.URI
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Locale

internal data class CapturedCookie(
  val name: String,
  val value: String,
  val domain: String,
  val path: String,
  val expires: Double,
  val httpOnly: Boolean,
  val secure: Boolean,
  val sameSite: String,
) {
  fun toMap(): Map<String, Any> = mapOf(
    "name" to name,
    "value" to value,
    "domain" to domain,
    "path" to path,
    "expires" to expires,
    "httpOnly" to httpOnly,
    "secure" to secure,
    "sameSite" to sameSite,
  )
}

internal object CloudBrowserCookieParser {
  fun parse(rawCookie: String, requestUri: URI, nowEpochSeconds: Long): CapturedCookie? {
    val segments = splitAttributes(rawCookie)
    val pair = segments.firstOrNull() ?: return null
    val pairSeparator = pair.indexOf('=')
    if (pairSeparator <= 0) return null

    val name = pair.substring(0, pairSeparator).trim()
    val value = pair.substring(pairSeparator + 1).trim()
    if (name.isEmpty() || containsUnsafeHeaderCharacter(name) || containsUnsafeHeaderCharacter(value)) {
      return null
    }

    val attributes = segments.drop(1).mapNotNull { segment ->
      val trimmed = segment.trim()
      if (trimmed.isEmpty()) return@mapNotNull null
      val separator = trimmed.indexOf('=')
      val key = (if (separator < 0) trimmed else trimmed.substring(0, separator))
        .trim()
        .lowercase(Locale.US)
      val attributeValue = if (separator < 0) "" else trimmed.substring(separator + 1).trim()
      key to attributeValue
    }
    val attributeMap = attributes.toMap()
    if (attributeMap.containsKey("partitioned")) return null

    val hostname = requestUri.host?.lowercase(Locale.US) ?: return null
    val rawDomain = attributeMap["domain"].orEmpty()
    val domain = (rawDomain.ifEmpty { hostname }).lowercase(Locale.US)
    val comparableDomain = domain.trimStart('.')
    if (hostname != comparableDomain && !hostname.endsWith(".$comparableDomain")) return null

    val secure = attributeMap.containsKey("secure")
    if (secure && requestUri.scheme.lowercase(Locale.US) != "https") return null

    val expires = parseExpiry(attributeMap["expires"])
    if (expires != null && expires <= nowEpochSeconds) return null
    val sameSite = when (attributeMap["samesite"]?.lowercase(Locale.US)) {
      "strict" -> "Strict"
      "none" -> "None"
      else -> "Lax"
    }

    return CapturedCookie(
      name = name,
      value = value,
      domain = domain,
      path = attributeMap["path"].orEmpty().ifEmpty { "/" },
      expires = expires?.toDouble() ?: -1.0,
      httpOnly = attributeMap.containsKey("httponly"),
      secure = secure,
      sameSite = sameSite,
    )
  }

  private fun splitAttributes(value: String): List<String> {
    val result = mutableListOf<String>()
    val current = StringBuilder()
    var quoted = false
    var escaped = false
    value.forEach { character ->
      when {
        escaped -> {
          current.append(character)
          escaped = false
        }
        character == '\\' && quoted -> {
          current.append(character)
          escaped = true
        }
        character == '"' -> {
          current.append(character)
          quoted = !quoted
        }
        character == ';' && !quoted -> {
          result.add(current.toString())
          current.clear()
        }
        else -> current.append(character)
      }
    }
    result.add(current.toString())
    return result
  }

  private fun parseExpiry(rawValue: String?): Long? {
    if (rawValue.isNullOrBlank()) return null
    return try {
      ZonedDateTime.parse(rawValue, DateTimeFormatter.RFC_1123_DATE_TIME).toEpochSecond()
    } catch (_: DateTimeParseException) {
      null
    }
  }

  private fun containsUnsafeHeaderCharacter(value: String): Boolean =
    value.any { character -> character == '\r' || character == '\n' || character == '\u0000' }
}
