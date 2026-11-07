import Foundation

final class MockProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))!
    static var requests: [URLRequest] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            Self.requests.append(request)
            let (code, data) = try Self.handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: ["Content-Type":"application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@main struct FalClientTests {
    static var checks = 0
    static func check(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        checks += 1
        if !condition() { throw NSError(domain: "FalTests", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func data(_ object: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: object) }
    static func bodyData(_ req: URLRequest) -> Data {
        if let body = req.httpBody { return body }
        guard let stream = req.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var body = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; body.append(buffer, count: n) }
        return body
    }
    static func main() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockProtocol.self]
        let session = URLSession(configuration: config)
        let base = URL(string: "https://queue.fal.run")!
        let client = FalClient(apiKey: "TEST_ONLY_NOT_REAL", session: session)
        let id = "test-request"
        let responseURL = base.appendingPathComponent("fal-ai/kling-video/requests/\(id)")
        let job = FalJob(requestID: id, statusURL: responseURL.appendingPathComponent("status"), responseURL: responseURL,
                         cancelURL: responseURL.appendingPathComponent("cancel"), model: .klingStandard, createdAt: Date())
        let image = URL(string: "https://v3b.fal.media/image.jpg")!
        let video = URL(string: "https://v3b.fal.media/video.mp4")!

        try check(FalModel.klingStandard.estimate(seconds: 5) == 0.63, "5s standard estimate")
        try check(abs(FalModel.klingPro.estimate(seconds: 5.01) - 1.008) < 0.000001, "estimate conservatively rounds up")
        let encoded = try JSONEncoder().encode(job)
        let decoded = try JSONDecoder().decode(FalJob.self, from: encoded)
        try check(decoded.requestID == id && decoded.model == .klingStandard, "resume job coding")
        try check(!String(data: encoded, encoding: .utf8)!.contains("TEST_ONLY"), "job excludes key")

        MockProtocol.handler = { req in
            try check(req.httpMethod == "GET" && req.url!.host == "api.fal.ai", "read-only pricing URL")
            try check(req.value(forHTTPHeaderField: "Authorization") == "Key TEST_ONLY_NOT_REAL", "auth header")
            return (200, data(["prices": [["endpoint_id": FalModel.klingStandard.endpoint, "unit_price": 0.126, "unit": "second", "currency": "USD"]]]))
        }
        let price = try await client.pricing(model: .klingStandard)
        try check(price.pricePerSecond == 0.126, "per-second pricing")
        try check(FalPrice(unitPrice: 12, unit: "video", currency: "USD").pricePerSecond == nil, "ambiguous billing unit not silently seconds")

        MockProtocol.requests = []
        MockProtocol.handler = { req in
            try check(req.httpMethod == "POST", "one submit POST")
            try check(req.url!.path == "/fal-ai/kling-video/v3/standard/motion-control", "full submit endpoint")
            try check(req.value(forHTTPHeaderField: "X-Fal-No-Retry") == "1", "server retry disabled")
            let body = try JSONSerialization.jsonObject(with: bodyData(req)) as! [String: Any]
            try check(body["character_orientation"] as? String == "video", "dance orientation")
            try check(body["keep_original_sound"] as? Bool == true, "preserve dance sound")
            try check(body["enable_safety_checker"] as? Bool == true, "safety checker enabled")
            try check(body["elements"] == nil, "no facial element by default")
            try check(body["prompt"] as? String == "Dance", "default prompt preserved")
            return (200, data(["request_id": id, "status_url":job.statusURL.absoluteString, "response_url":job.responseURL.absoluteString, "cancel_url":job.cancelURL.absoluteString]))
        }
        let submitted = try await client.submit(imageURL: image, videoURL: video, model: .klingStandard, prompt: "Dance", keepSound: true)
        try check(submitted.statusURL == job.statusURL, "server returned status URL preserved")
        try check(MockProtocol.requests.count == 1, "no duplicate submit")

        let face = URL(string: "https://v3b.fal.media/face.jpg")!
        MockProtocol.handler = { req in
            let body = try JSONSerialization.jsonObject(with: bodyData(req)) as! [String: Any]
            let elements = body["elements"] as? [[String: Any]]
            try check(elements?.count == 1, "exactly one identity element")
            try check(elements?.first?["frontal_image_url"] as? String == face.absoluteString, "element frontal image")
            try check(elements?.first?["reference_image_urls"] as? [String] == [image.absoluteString], "element reference is own main image")
            try check(body["character_orientation"] as? String == "video", "identity uses video orientation")
            let text = body["prompt"] as? String ?? ""
            try check(text.contains("@Element1"), "identity element referenced in prompt")
            try check(text.components(separatedBy: "@Element1").count == 2, "identity marker not duplicated")
            return (200, data(["request_id": id]))
        }
        _ = try await client.submit(imageURL:image, videoURL:video, model:.klingPro, prompt:"Dance", keepSound:true, frontalImageURL:face)
        _ = try await client.submit(imageURL:image, videoURL:video, model:.klingPro, prompt:"@Element1 dances", keepSound:true, frontalImageURL:face)
        MockProtocol.requests = []
        do { _ = try await client.submit(imageURL:image, videoURL:video, model:.klingPro, prompt:"", keepSound:true, frontalImageURL:URL(string:"https://evil.example/face.jpg")!); throw NSError(domain:"expected",code:1) }
        catch FalError.unsafeURL { try check(MockProtocol.requests.isEmpty, "unsafe face URL rejected before submission") }

        MockProtocol.handler = { _ in (200, data(["status":"IN_QUEUE", "queue_position":2])) }
        let queued = try await client.status(job: job)
        try check(queued.status == "IN_QUEUE" && queued.queuePosition == 2, "queue state")
        MockProtocol.handler = { _ in (200, data(["status":"IN_PROGRESS", "logs":[["message":"TEST_ONLY_NOT_REAL https://private.example/file person"]]])) }
        let running = try await client.status(job: job)
        try check(running.logs.first == "[verborgen] [bestand] person", "redacts keys and URLs from server logs")
        MockProtocol.handler = { _ in (200, data(["status":"COMPLETED", "error":"private details TEST_ONLY_NOT_REAL"])) }
        let failed = try await client.status(job: job)
        try check(failed.error != nil && !failed.error!.contains("TEST_ONLY"), "failed COMPLETED status error redacted")
        MockProtocol.handler = { _ in (200, data(["video":["url":video.absoluteString]])) }
        let result = try await client.result(job: job)
        try check(result == video, "result MP4 URL")

        MockProtocol.handler = { req in
            try check(req.httpMethod == "PUT" && req.url == job.cancelURL, "cancel PUT official URL")
            return (202, data(["status":"CANCELLATION_REQUESTED"]))
        }
        try await client.cancel(job: job)

        MockProtocol.requests = []
        MockProtocol.handler = { _ in (500, Data()) }
        do { _ = try await client.submit(imageURL:image, videoURL:video, model:.klingStandard, prompt:"", keepSound:true); throw NSError(domain:"expected",code:1) }
        catch FalError.ambiguousSubmission { try check(MockProtocol.requests.count == 1, "ambiguous submission never retried") }

        MockProtocol.handler = { _ in (401, data(["detail":"TEST_ONLY_NOT_REAL"])) }
        do { _ = try await client.pricing(model:.klingStandard); throw NSError(domain:"expected",code:1) }
        catch FalError.http(let code) { try check(code == 401, "auth errors distinguished") }

        MockProtocol.requests = []
        let unsafe = FalJob(requestID:id, statusURL:URL(string:"https://evil.example/steal")!, responseURL:responseURL, cancelURL:job.cancelURL, model:.klingStandard, createdAt:Date())
        do { _ = try await client.status(job:unsafe); throw NSError(domain:"expected",code:1) }
        catch FalError.unsafeURL { try check(MockProtocol.requests.isEmpty, "foreign queue URL never receives key") }
        MockProtocol.handler = { _ in (200, data(["request_id":id,"status_url":"https://evil.example/steal"])) }
        do { _ = try await client.submit(imageURL:image, videoURL:video, model:.klingStandard, prompt:"", keepSound:true); throw NSError(domain:"expected",code:1) }
        catch FalError.unsafeURL { checks += 1 }

        MockProtocol.requests = []
        do { _ = try await client.submit(imageURL:URL(string:"file:///etc/passwd")!, videoURL:video, model:.klingStandard, prompt:"", keepSound:true); throw NSError(domain:"expected",code:1) }
        catch FalError.unsafeURL { try check(MockProtocol.requests.isEmpty, "local-file URL cannot be submitted") }

        let fixture = FileManager.default.temporaryDirectory.appendingPathComponent("fal-upload-test-\(UUID()).jpg")
        try Data([1,2,3,4]).write(to:fixture)
        defer { try? FileManager.default.removeItem(at:fixture) }
        MockProtocol.requests = []
        MockProtocol.handler = { req in
            if req.url!.host == "rest.fal.ai" {
                try check(req.httpMethod == "POST" && req.url!.path == "/storage/upload/initiate", "upload initiate path")
                let body = try JSONSerialization.jsonObject(with:bodyData(req)) as! [String:Any]
                try check(body["content_type"] as? String == "image/jpeg", "upload content type")
                try check(!(body["file_name"] as! String).contains("fal-upload-test"), "private original filename not sent")
                return (200, data(["upload_url":"https://v3b.fal.media/presigned", "file_url":image.absoluteString]))
            }
            try check(req.httpMethod == "PUT", "upload PUT")
            try check(req.value(forHTTPHeaderField:"Authorization") == nil, "no API key sent to media CDN")
            return (200, Data())
        }
        let uploaded = try await client.upload(file:fixture,mimeType:"image/jpeg")
        try check(uploaded == image && MockProtocol.requests.count == 2, "upload returns CDN URL")
        let zero = FileManager.default.temporaryDirectory.appendingPathComponent("fal-empty-\(UUID())")
        try Data().write(to:zero)
        defer { try? FileManager.default.removeItem(at:zero) }
        do { _ = try await client.upload(file:zero,mimeType:"video/mp4"); throw NSError(domain:"expected",code:1) }
        catch FalError.invalidFile { checks += 1 }

        let downloadTarget = FileManager.default.temporaryDirectory.appendingPathComponent("fal-download-\(UUID()).mp4")
        defer { try? FileManager.default.removeItem(at:downloadTarget) }
        MockProtocol.handler = { req in
            try check(req.value(forHTTPHeaderField:"Authorization") == nil, "download no credentials")
            return (200, Data([0,0,0,24,102,116,121,112]))
        }
        try await client.download(from:video,to:downloadTarget)
        let downloaded = try Data(contentsOf:downloadTarget)
        try check(downloaded.count == 8, "download saves bytes")

        let already = FileManager.default.temporaryDirectory.appendingPathComponent("fal-existing-\(UUID()).mp4")
        try Data([7,8,9]).write(to:already)
        defer { try? FileManager.default.removeItem(at:already) }
        MockProtocol.requests = []
        do { try await client.download(from:video,to:already); throw NSError(domain:"expected",code:1) }
        catch FalError.existingFile { try check(MockProtocol.requests.isEmpty, "download never overwrites existing file") }

        print("PASS: \(checks) fal client checks; mocked only, no fal credits spent")
    }
}
