import Foundation

// Official API docs checked 2026-11-03. No credentials or personal media belong in source control.
// https://fal.ai/models/fal-ai/kling-video/v3/standard/motion-control/api
// https://fal.ai/docs/documentation/model-apis/inference/queue
// Upload protocol: https://github.com/fal-ai/fal-js/blob/main/libs/client/src/storage.ts

enum FalModel: String, Codable, CaseIterable, Identifiable, Sendable {
    case klingStandard, klingPro
    var id: String { rawValue }
    var endpoint: String {
        "fal-ai/kling-video/v3/\(self == .klingPro ? "pro" : "standard")/motion-control"
    }
    var title: String { self == .klingPro ? "Kling 3 Pro" : "Kling 3 Standard" }
    var pricePerSecond: Double { self == .klingPro ? 0.168 : 0.126 }
    var documentationURL: URL { URL(string: "https://fal.ai/models/\(endpoint)")! }
    func estimate(seconds: Double) -> Double {
        // Round duration up for a cautious estimate rather than implying exact account billing.
        ceil(max(0, seconds)) * pricePerSecond
    }
}

struct FalJob: Codable, Sendable {
    let requestID: String
    let statusURL: URL
    let responseURL: URL
    let cancelURL: URL
    let model: FalModel
    let createdAt: Date
}

struct FalStatus: Sendable {
    let status: String
    let queuePosition: Int?
    let logs: [String]
    let error: String?
}

struct FalPrice: Sendable {
    let unitPrice: Double
    let unit: String
    let currency: String
    var pricePerSecond: Double? {
        let normalized = unit.lowercased().replacingOccurrences(of: "_", with: " ")
        return ["second", "seconds", "video second", "video seconds", "s"].contains(normalized) && currency == "USD" ? unitPrice : nil
    }
}

enum FalError: LocalizedError {
    case missingKey, unsafeURL, invalidResponse, invalidFile, existingFile, network, ambiguousSubmission, http(Int), generationFailed
    var errorDescription: String? {
        switch self {
        case .missingKey: return "Bewaar eerst je fal.ai API-key in Sleutelhanger."
        case .unsafeURL: return "fal.ai gaf een onverwacht webadres terug. De aanvraag is veilig gestopt."
        case .invalidResponse: return "Het antwoord van fal.ai is onvolledig of onleesbaar. Controleer de bewaarde aanvraag."
        case .invalidFile: return "Het voorbereide bestand is leeg of groter dan 90 MB. Kies een kortere clip."
        case .existingFile: return "Er bestaat al een bestand op deze locatie. Kies een andere bestandsnaam."
        case .network: return "Geen verbinding met fal.ai. Je kunt de bestaande aanvraag later opnieuw ophalen."
        case .ambiguousSubmission: return "De verbinding viel weg tijdens het indienen. De generatie kan al gestart zijn. Controleer eerst je fal.ai-dashboard voordat je opnieuw genereert."
        case .generationFailed: return "fal.ai kon deze generatie niet voltooien. Controleer de aanvraag in je fal.ai-dashboard."
        case .http(let code):
            switch code {
            case 401, 403: return "fal.ai weigert deze API-key of toegang (\(code)). Controleer je key en toegangsrechten."
            case 402: return "Je fal.ai-tegoed is onvoldoende. Vul je credits aan in je fal.ai-account."
            case 404: return "Deze fal.ai-aanvraag of dit model is niet beschikbaar (404)."
            case 422: return "fal.ai heeft de invoer afgekeurd (422). Controleer de referentie, persoon en modelvoorwaarden in je dashboard."
            case 429: return "fal.ai is tijdelijk te druk (429). Probeer de bestaande aanvraag later opnieuw op te halen."
            default: return "fal.ai gaf een fout (HTTP \(code)). Je bestaande aanvraag blijft bewaard."
            }
        }
    }
}

final class FalClient: @unchecked Sendable {
    private let apiKey: String
    private let session: URLSession
    private let queueBase: URL
    private let restBase: URL
    private let platformBase: URL

    init(apiKey: String, session: URLSession = .shared,
         queueBase: URL = URL(string: "https://queue.fal.run")!,
         restBase: URL = URL(string: "https://rest.fal.ai")!,
         platformBase: URL = URL(string: "https://api.fal.ai/v1")!) {
        self.apiKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        self.session = session
        self.queueBase = queueBase
        self.restBase = restBase
        self.platformBase = platformBase
    }

    /// Read-only authentication + current unit pricing. This never starts a generation.
    func pricing(model: FalModel) async throws -> FalPrice {
        var parts = URLComponents(url: platformBase.appendingPathComponent("models/pricing"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "endpoint_id", value: model.endpoint)]
        let object = try await json(request(try requireURL(parts.url), method: "GET"))
        guard let prices = object["prices"] as? [[String: Any]],
              let price = prices.first(where: { $0["endpoint_id"] as? String == model.endpoint }),
              let amount = price["unit_price"] as? Double, amount.isFinite, amount >= 0,
              let unit = price["unit"] as? String, let currency = price["currency"] as? String else { throw FalError.invalidResponse }
        return FalPrice(unitPrice: amount, unit: unit, currency: currency)
    }

    /// Prepared files only. CDN upload is separate from the paid queue submission.
    func upload(file: URL, mimeType: String) async throws -> URL {
        let attrs = try FileManager.default.attributesOfItem(atPath: file.path)
        guard let size = attrs[.size] as? NSNumber, size.intValue > 0, size.intValue <= 90 * 1024 * 1024 else { throw FalError.invalidFile }
        var parts = URLComponents(url: restBase.appendingPathComponent("storage/upload/initiate"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "storage_type", value: "fal-cdn-v3")]
        var initiate = try request(requireURL(parts.url), method: "POST")
        initiate.setValue("{\"expiration_duration_seconds\":86400}", forHTTPHeaderField: "X-Fal-Object-Lifecycle")
        initiate.httpBody = try JSONSerialization.data(withJSONObject: ["file_name": "\(UUID().uuidString).\(mimeType == "video/mp4" ? "mp4" : "jpg")", "content_type": mimeType])
        let response = try await json(initiate)
        guard let uploadString = response["upload_url"] as? String,
              let fileString = response["file_url"] as? String,
              let uploadURL = URL(string: uploadString), let fileURL = URL(string: fileString),
              safeMediaURL(uploadURL), safeMediaURL(fileURL) else { throw FalError.unsafeURL }
        var put = URLRequest(url: uploadURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 300)
        put.httpMethod = "PUT"
        put.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        put.httpShouldHandleCookies = false
        // The presigned upload gets no API-key header.
        let (_, http) = try await transferredUpload(put, file: file)
        try check(http)
        return fileURL
    }

    /// Call only after the app's explicit cost confirmation. Never automatically retried.
    func submit(imageURL: URL, videoURL: URL, model: FalModel, prompt: String, keepSound: Bool, frontalImageURL: URL? = nil, angleImageURLs: [URL] = []) async throws -> FalJob {
        guard safeMediaURL(imageURL), safeMediaURL(videoURL) else { throw FalError.unsafeURL }
        if let frontalImageURL, !safeMediaURL(frontalImageURL) { throw FalError.unsafeURL }
        guard angleImageURLs.allSatisfy(safeMediaURL) else { throw FalError.unsafeURL }
        var req = try request(queueBase.appendingPathComponent(model.endpoint), method: "POST")
        req.setValue("1", forHTTPHeaderField: "X-Fal-No-Retry")
        req.setValue("{\"expiration_duration_seconds\":604800}", forHTTPHeaderField: "X-Fal-Object-Lifecycle-Preference")
        var finalPrompt = String(prompt.prefix(2000))
        if frontalImageURL != nil && !finalPrompt.contains("@Element1") {
            finalPrompt += " The person is @Element1."
        }
        var input: [String: Any] = [
            "image_url": imageURL.absoluteString, "video_url": videoURL.absoluteString,
            "character_orientation": "video", "prompt": finalPrompt,
            "keep_original_sound": keepSound, "enable_safety_checker": true
        ]
        if let frontalImageURL {
            // Kling v3 accepts one inline facial element; this is part of the same generation.
            input["elements"] = [["frontal_image_url": frontalImageURL.absoluteString,
                                   "reference_image_urls": angleImageURLs.isEmpty ? [imageURL.absoluteString] : angleImageURLs.prefix(3).map(\.absoluteString)]]
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: input)
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: req) }
        catch { throw FalError.ambiguousSubmission }
        guard let http = response as? HTTPURLResponse else { throw FalError.ambiguousSubmission }
        // A 5xx may have occurred after the queue accepted the request.
        if http.statusCode >= 500 { throw FalError.ambiguousSubmission }
        try check(http)
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let requestID = object["request_id"] as? String, !requestID.isEmpty else { throw FalError.ambiguousSubmission }
        // The server convenience URLs intentionally omit the model's endpoint suffix.
        let fallback = queueBase.appendingPathComponent("fal-ai/kling-video/requests").appendingPathComponent(requestID)
        func queueURL(_ key: String, fallback: URL) throws -> URL {
            guard let value = object[key] as? String else { return fallback }
            guard let result = URL(string: value), sameOrigin(result, queueBase) else { throw FalError.unsafeURL }
            return result
        }
        return try FalJob(requestID: requestID,
                          statusURL: queueURL("status_url", fallback: fallback.appendingPathComponent("status")),
                          responseURL: queueURL("response_url", fallback: fallback),
                          cancelURL: queueURL("cancel_url", fallback: fallback.appendingPathComponent("cancel")),
                          model: model, createdAt: Date())
    }

    func status(job: FalJob) async throws -> FalStatus {
        try validateQueueURL(job.statusURL)
        var parts = URLComponents(url: job.statusURL, resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "logs", value: "1")]
        let object = try await json(request(requireURL(parts.url), method: "GET"))
        guard let state = object["status"] as? String else { throw FalError.invalidResponse }
        let logs = (object["logs"] as? [[String: Any]] ?? []).compactMap { $0["message"] as? String }.map(sanitized)
        return FalStatus(status: state, queuePosition: object["queue_position"] as? Int,
                         logs: logs, error: object["error"] == nil || object["error"] is NSNull ? nil : FalError.generationFailed.localizedDescription)
    }

    func result(job: FalJob) async throws -> URL {
        try validateQueueURL(job.responseURL)
        let object = try await json(request(job.responseURL, method: "GET"))
        guard let video = object["video"] as? [String: Any], let value = video["url"] as? String,
              let url = URL(string: value), safeMediaURL(url) else { throw FalError.invalidResponse }
        return url
    }

    /// 202 only requests cancellation; the app must keep the request record until settled.
    func cancel(job: FalJob) async throws {
        try validateQueueURL(job.cancelURL)
        _ = try await json(request(job.cancelURL, method: "PUT"), allowEmpty: true)
    }

    func download(from url: URL, to destination: URL) async throws {
        guard safeMediaURL(url) else { throw FalError.unsafeURL }
        guard !FileManager.default.fileExists(atPath: destination.path) else { throw FalError.existingFile }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 300)
        req.httpShouldHandleCookies = false
        let temporary: URL
        let response: URLResponse
        do { (temporary, response) = try await session.download(for: req) }
        catch is CancellationError { throw CancellationError() }
        catch { throw FalError.network }
        defer { try? FileManager.default.removeItem(at: temporary) }
        guard let http = response as? HTTPURLResponse else { throw FalError.invalidResponse }
        try check(http)
        let size = try FileManager.default.attributesOfItem(atPath: temporary.path)[.size] as? NSNumber
        guard (size?.intValue ?? 0) > 0 else { throw FalError.invalidFile }
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: temporary, to: destination)
    }

    private func request(_ url: URL, method: String) throws -> URLRequest {
        guard !apiKey.isEmpty, !apiKey.contains("\n"), !apiKey.contains("\r") else { throw FalError.missingKey }
        guard sameOrigin(url, queueBase) || sameOrigin(url, restBase) || sameOrigin(url, platformBase) else { throw FalError.unsafeURL }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 90)
        req.httpMethod = method
        req.httpShouldHandleCookies = false
        req.setValue("Key \(apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return req
    }

    private func json(_ request: URLRequest, allowEmpty: Bool = false) async throws -> [String: Any] {
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch is CancellationError { throw CancellationError() }
        catch { throw FalError.network }
        guard let http = response as? HTTPURLResponse else { throw FalError.invalidResponse }
        try check(http)
        if allowEmpty && data.isEmpty { return [:] }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw FalError.invalidResponse }
        return object
    }

    private func transferredUpload(_ request: URLRequest, file: URL) async throws -> (Data, HTTPURLResponse) {
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.upload(for: request, fromFile: file) }
        catch is CancellationError { throw CancellationError() }
        catch { throw FalError.network }
        guard let http = response as? HTTPURLResponse else { throw FalError.invalidResponse }
        return (data, http)
    }

    private func check(_ response: HTTPURLResponse) throws {
        guard (200...299).contains(response.statusCode) else { throw FalError.http(response.statusCode) }
    }
    private func requireURL(_ url: URL?) throws -> URL {
        guard let url else { throw FalError.unsafeURL }; return url
    }
    private func validateQueueURL(_ url: URL) throws {
        guard sameOrigin(url, queueBase), url.path.hasPrefix("/fal-ai/kling-video/requests/") else { throw FalError.unsafeURL }
    }
    private func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        a.scheme == b.scheme && a.host == b.host && a.port == b.port && a.user == nil && a.password == nil
    }
    private func safeMediaURL(_ url: URL) -> Bool {
        guard url.user == nil, url.password == nil else { return false }
        if sameOrigin(url, restBase) || sameOrigin(url, queueBase) { return true } // injected test hosts
        guard url.scheme == "https", let host = url.host?.lowercased() else { return false }
        return host == "fal.media" || host.hasSuffix(".fal.media") || host == "fal.ai" || host.hasSuffix(".fal.ai") || host.hasSuffix(".fal.run")
    }
    private func sanitized(_ value: String) -> String {
        String(value.replacingOccurrences(of: apiKey, with: "[verborgen]")
            .replacingOccurrences(of: #"https?://\S+|data:\S+"#, with: "[bestand]", options: .regularExpression).prefix(400))
    }
}
