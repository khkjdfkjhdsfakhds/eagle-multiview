package com.eaglemultiview.android

/** Offline supplementary probe of product code; not a Gradle or device acceptance. */
fun main() {
    var failed = 0
    fun verify(name: String, action: () -> Unit) {
        try { action(); println("PASS $name") }
        catch (failure: Throwable) { failed++; println("FAIL $name: ${failure.message}") }
    }
    verify("AD-01 URL identity and restore idempotence") {
        for ((input, encoded) in mapOf(
            "/folder%20name/" to "/folder%20name/", "/资料/" to "/%E8%B5%84%E6%96%99/",
            "/literal%25value/" to "/literal%25value/", "/encoded%2Fsegment/" to "/encoded%2Fsegment/"
        )) {
            var value = "https://EXAMPLE.test:443$input"
            repeat(4) {
                value = HostUrlValidator.normalize(value) ?: error("Rejected $input")
                check(value == "https://example.test$encoded") { value }
            }
        }
    }
    verify("AD-02 valid port boundaries and native error enum") {
        for (port in listOf(0, 65536)) {
            check(HostUrlValidator.validate("http://example.test:$port/") == HostInputResult.Invalid(HostInputError.INVALID_PORT)) { "Accepted port $port" }
        }
        for (url in listOf("http://example.test/", "http://example.test:1/", "http://example.test:65535/", "http://[::1]:41596/")) {
            check(HostUrlValidator.normalize(url) == url) { url }
        }
    }
    verify("negative controls for credentials schemes and trust") {
        check(HostUrlValidator.normalize("file:///tmp/notes") == null)
        check(HostUrlValidator.normalize("http://user:pass@example.test/") == null)
        val endpoint = (HostUrlValidator.validate("https://example.test/") as HostInputResult.Valid).endpoint
        check(endpoint.contains("https://example.test/folder%20name/"))
        check(!endpoint.contains("http://example.test/"))
    }
    check(failed == 0) { "$failed failed contracts" }
}
