package com.stella.cloudbrowsersession

import java.net.URI
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CloudBrowserCookieParserTest {
  private val requestUri = URI("https://account.example.com/login")
  private val now = 1_788_250_000L

  @Test
  fun parsesCompleteHttpOnlyCookie() {
    val cookie = CloudBrowserCookieParser.parse(
      "session=secret; Domain=.example.com; Path=/; Expires=Tue, 01 Sep 2026 12:00:00 GMT; Secure; HttpOnly; SameSite=None",
      requestUri,
      now,
    )

    requireNotNull(cookie)
    assertEquals("session", cookie.name)
    assertEquals("secret", cookie.value)
    assertEquals(".example.com", cookie.domain)
    assertEquals("/", cookie.path)
    assertEquals(true, cookie.httpOnly)
    assertEquals(true, cookie.secure)
    assertEquals("None", cookie.sameSite)
  }

  @Test
  fun preservesQuotedSemicolonInValue() {
    val cookie = CloudBrowserCookieParser.parse(
      "session=\"left;right\"; Path=/login; Secure",
      requestUri,
      now,
    )

    assertEquals("\"left;right\"", cookie?.value)
    assertEquals("/login", cookie?.path)
  }

  @Test
  fun rejectsCookiesOutsideTheRequestedHost() {
    assertNull(
      CloudBrowserCookieParser.parse(
        "session=secret; Domain=attacker.example; Path=/; Secure",
        requestUri,
        now,
      ),
    )
  }

  @Test
  fun rejectsPartitionedCookiesThatCannotBeTransferredFaithfully() {
    assertNull(
      CloudBrowserCookieParser.parse(
        "session=secret; Path=/; Secure; Partitioned",
        requestUri,
        now,
      ),
    )
  }

  @Test
  fun rejectsExpiredCookies() {
    assertNull(
      CloudBrowserCookieParser.parse(
        "session=secret; Path=/; Expires=Tue, 01 Sep 2020 12:00:00 GMT; Secure",
        requestUri,
        now,
      ),
    )
  }
}
