import AppKit
import AVKit
import SwiftUI
import UniformTypeIdentifiers

struct SavedRun: Codable, Identifiable {
    var id: String
    var job: FalJob
    var directory: URL
    var estimate: Double
    var resultURL: URL?
}

@MainActor
final class AppModel: ObservableObject {
    @Published var library: [LibraryVideo] = []
    @Published var personURL: URL?
    @Published var faceURL: URL? { didSet { UserDefaults.standard.set(faceURL?.path, forKey: "facePath") } }
    @Published var backgroundURL: URL? { didSet { UserDefaults.standard.set(backgroundURL?.path, forKey: "backgroundPath") } }
    @Published var personOffset = UserDefaults.standard.double(forKey: "personOffset") { didSet { UserDefaults.standard.set(personOffset, forKey: "personOffset") } }
    /// Up to three extra views (side, back) sent with the face element.
    @Published var angleURLs: [URL] = [] { didSet { UserDefaults.standard.set(angleURLs.map(\.path), forKey: "anglePaths") } }
    @Published var danceURL: URL?
    @Published var personMetadata: VideoMetadata?
    @Published var danceMetadata: VideoMetadata?
    @Published var personTime = 0.0
    @Published var danceStart = 0.0
    @Published var duration = 5.0
    @Published var model: FalModel = .klingPro
    @Published var cropEnabled = false
    @Published var cropX = 0.0
    @Published var cropY = 0.0
    @Published var cropWidth = 720.0
    @Published var cropHeight = 1280.0
    @Published var prompt = "A realistic video of the reference person performing the dance, natural movement, preserve their face, body and clothing."
    @Published var keepSound = true
    @Published var steadyCamera = true
    @Published var referenceImage: NSImage?
    @Published var prepared: PreparedMedia?
    @Published var preparationProgress = 0.0
    @Published var busy = false
    @Published var isGenerating = false
    @Published var status = "Kies je eigen video en een dansreferentie."
    @Published var error: String?
    @Published var keyAvailable = false
    @Published var keyNotice = ""
    @Published var showKeySheet = false
    @Published var showCostConfirmation = false
    @Published var resultURL: URL?
    @Published var resultPlayer: AVPlayer?
    @Published var dancePlayer: AVPlayer?
    @Published var runs: [SavedRun] = []
    @Published var pendingRun: SavedRun?
    @Published var elapsed = 0
    @Published var submissionUncertain = false
    @Published var quotedRate: Double?
    @Published var quotedModel: FalModel?
    @Published var priceNotice = "Tarief gecontroleerd op 3 november 2026."
    private var task: Task<Void, Never>?
    private var referenceTask: Task<Void, Never>?
    private var frameRevision = UUID()
    private var inputRevision = UUID()
    private var personRevision = UUID()
    private var danceRevision = UUID()
    private let support: URL

    init() {
        support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("DanceForge", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
            submissionUncertain = FileManager.default.fileExists(atPath: support.appendingPathComponent("submission-uncertain.txt").path)
            if let data = try? Data(contentsOf: support.appendingPathComponent("runs.json")) {
                runs = try JSONDecoder().decode([SavedRun].self, from: data)
                pendingRun = runs.first(where: { $0.resultURL == nil })
            }
            keyAvailable = try KeychainStore.load() != nil
            if !keyAvailable, try KeychainStore.importExistingKeyIfAvailable() {
                keyAvailable = true
                keyNotice = "Je bestaande fal.ai-key is overgenomen in Sleutelhanger."
            }
        } catch { self.error = "Instellingen laden: \(error.localizedDescription)" }
        refreshLibrary()
        for (key, isPerson) in [("personPath", true), ("dancePath", false)] {
            if let path = UserDefaults.standard.string(forKey: key), FileManager.default.isReadableFile(atPath: path) {
                select(URL(fileURLWithPath: path), person: isPerson)
            }
        }
        if let path = UserDefaults.standard.string(forKey: "facePath"), FileManager.default.isReadableFile(atPath: path) {
            faceURL = URL(fileURLWithPath: path)
        }
        angleURLs = (UserDefaults.standard.stringArray(forKey: "anglePaths") ?? [])
            .filter { FileManager.default.isReadableFile(atPath: $0) }.prefix(3).map { URL(fileURLWithPath: $0) }
        if let path = UserDefaults.standard.string(forKey: "backgroundPath"), FileManager.default.isReadableFile(atPath: path) {
            backgroundURL = URL(fileURLWithPath: path)
        }
        let lastOpened = UserDefaults.standard.string(forKey: "lastResultPath").map { URL(fileURLWithPath: $0) }
        if let lastOpened, FileManager.default.isReadableFile(atPath: lastOpened.path) {
            openResult(lastOpened)
        } else if let latest = runs.compactMap(\.resultURL).first, FileManager.default.isReadableFile(atPath: latest.path) {
            openResult(latest)
        }
    }

    var cost: Double { ceil(prepared?.duration ?? duration) * (quotedModel == model ? quotedRate ?? model.pricePerSecond : model.pricePerSecond) }
    var costLabel: String { String(format: "$%.2f", cost) }
    var canPrepare: Bool { personURL != nil && danceURL != nil && !busy }
    var canGenerate: Bool { prepared != nil && keyAvailable && !busy && pendingRun == nil && !submissionUncertain }
    var maxDuration: Double { min(20, max(3, (danceMetadata?.duration ?? 20) - danceStart)) }
    var maxStart: Double { max(0, (danceMetadata?.duration ?? 3) - 3) }
    var personMaxTime: Double { max(0, (personMetadata?.duration ?? 0) - 0.05) }
    var crop: VideoCrop? { cropEnabled ? VideoCrop(x: cropX, y: cropY, width: cropWidth, height: cropHeight) : nil }
    var inputDescription: String {
        "Persoon: \(personURL?.lastPathComponent ?? "—")\nGezicht: \(faceURL?.lastPathComponent ?? "geen extra beeld")\(faceURL != nil && !angleURLs.isEmpty ? " + \(angleURLs.count) hoeken" : "")\nDans: \(danceURL?.lastPathComponent ?? "—")\nFragment: \(String(format: "%.2f", danceStart))–\(String(format: "%.2f", danceStart + (prepared?.duration ?? duration))) s\(cropEnabled ? " · met uitsnede" : "")\nAchtergrond: \(backgroundURL?.lastPathComponent ?? "uit het referentiebeeld")\nCamera: \(steadyCamera ? "vaste, ruime opname gevraagd" : "volgt de beschrijving")"
    }

    func refreshLibrary() { library = ExistingLibrary.scan() }

    func pickFace() {
        guard !busy else { return }
        let panel = NSOpenPanel(); panel.title = "Extra gezichtsreferentie"
        panel.allowedContentTypes = [.image]; panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url { faceURL = url }
    }

    func pickAngles() {
        guard !busy else { return }
        let panel = NSOpenPanel(); panel.title = "Kies tot 3 beelden van je zijkant en rug"
        panel.allowedContentTypes = [.image]; panel.allowsMultipleSelection = true
        if panel.runModal() == .OK { angleURLs = Array(panel.urls.prefix(3)) }
    }

    func pickBackground() {
        guard !busy else { return }
        let panel = NSOpenPanel(); panel.title = "Foto van je lege ruimte"
        panel.allowedContentTypes = [.image, .movie, .video]; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let isImage = UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) ?? false
        if isImage { backgroundURL = url; updateFrame(); return }
        // A video: use its first frame (start recording before you step into view).
        let target = support.appendingPathComponent("achtergrond-\(UUID().uuidString.prefix(8)).jpg")
        Task {
            do {
                try await MediaPreparation.extractReference(from: url, at: 0, to: target)
                backgroundURL = target; updateFrame()
            } catch { self.error = error.localizedDescription }
        }
    }

    func clearBackground() { backgroundURL = nil; updateFrame() }

    func pick(person: Bool) {
        guard !busy else { return }
        let panel = NSOpenPanel()
        panel.title = person ? "Kies je eigen video of referentiefoto" : "Kies de dansvideo"
        panel.allowedContentTypes = person ? [.movie, .video, .image] : [.movie, .video]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        if panel.runModal() == .OK, let url = panel.url { select(url, person: person) }
    }

    func select(_ url: URL, person: Bool) {
        guard !busy else { return }
        invalidate()
        UserDefaults.standard.set(url.path, forKey: person ? "personPath" : "dancePath")
        let revision = UUID()
        if person {
            referenceTask?.cancel(); frameRevision = UUID(); personRevision = revision
            personURL = url; personTime = 0; personMetadata = nil; referenceImage = nil
        } else {
            danceRevision = revision
            cropEnabled = false
            danceURL = url; danceStart = 0; danceMetadata = nil
            dancePlayer?.pause(); dancePlayer = AVPlayer(url: url)
        }
        Task {
            do {
                let isImage = UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) ?? false
                if person && isImage {
                    referenceImage = NSImage(contentsOf: url)
                    if referenceImage == nil { throw AppFailure("Deze foto kan niet worden geopend.") }
                } else {
                    let info = try await MediaPreparation.inspectVideo(url)
                    guard person ? self.personRevision == revision : self.danceRevision == revision else { return }
                    if person {
                        personMetadata = info
                        // Restore the frame chosen last time for this same video.
                        if UserDefaults.standard.string(forKey: "personTimePath") == url.path {
                            personTime = min(UserDefaults.standard.double(forKey: "personTime"), personMaxTime)
                        }
                        updateFrame()
                    }
                    else {
                        danceMetadata = info
                        cropX = 0; cropY = 0; cropWidth = Double(info.width); cropHeight = Double(info.height)
                        duration = min(5, floor(info.duration * 24) / 24)
                        if info.duration < 3 { throw AppFailure("De dansvideo moet minstens 3 seconden duren.") }
                    }
                }
            } catch { self.error = error.localizedDescription }
        }
    }

    func invalidate() {
        if prepared != nil, let danceURL {
            dancePlayer?.pause(); dancePlayer = AVPlayer(url: danceURL)
        }
        prepared = nil; preparationProgress = 0; inputRevision = UUID()
        if !busy { status = "Bereid de gekozen beelden voor." }
    }

    func updateFrame() {
        invalidate()
        guard let url = personURL, personMetadata != nil else { return }
        referenceTask?.cancel()
        let revision = UUID(); frameRevision = revision
        let time = personTime, background = backgroundURL, offset = personOffset
        UserDefaults.standard.set(time, forKey: "personTime"); UserDefaults.standard.set(url.path, forKey: "personTimePath")
        referenceTask = Task {
            do {
                let target = support.appendingPathComponent("preview-\(revision).jpg")
                defer { try? FileManager.default.removeItem(at: target) }
                try await MediaPreparation.extractReference(from: url, at: time, to: target)
                if let background {
                    try BackgroundComposite.apply(personImageURL: target, backgroundURL: background, offset: offset, to: target)
                }
                guard !Task.isCancelled, frameRevision == revision, personURL == url else { return }
                referenceImage = NSImage(contentsOf: target)
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }

    func prepare() {
        guard canPrepare, let personURL, let danceURL else { return }
        error = nil; busy = true; prepared = nil
        status = "Referentiebeeld en dansclip voorbereiden…"
        let directory = support.appendingPathComponent("Renders/\(UUID().uuidString)", isDirectory: true)
        let selectedTime = personTime, selectedStart = danceStart, selectedDuration = duration
        let selectedCrop = crop, selectedBackground = backgroundURL, selectedOffset = personOffset
        let revision = inputRevision
        task = Task {
            do {
                let media = try await MediaPreparation.prepare(personURL: personURL, personTime: selectedTime, danceURL: danceURL, danceStart: selectedStart, duration: selectedDuration, outputDirectory: directory, crop: selectedCrop, background: selectedBackground, personOffset: selectedOffset, progress: { value in
                    Task { @MainActor in self.preparationProgress = value }
                })
                try Task.checkCancellation()
                guard revision == inputRevision else { throw AppFailure("Je invoer is gewijzigd. Bereid de nieuwe beelden opnieuw voor.") }
                prepared = media
                referenceImage = NSImage(contentsOf: media.referenceImageURL)
                dancePlayer?.pause(); dancePlayer = AVPlayer(url: media.danceVideoURL)
                status = "Klaar: \(media.frameCount) beelden · \(Int(media.danceMetadata.frameRate.rounded())) fps · \(String(format: "%.2f", media.duration)) s. Controleer de previews."
            } catch { self.error = error.localizedDescription; status = "Voorbereiding gestopt." }
            busy = false
        }
    }

    func saveKey(_ key: String) {
        do {
            try KeychainStore.save(key.trimmingCharacters(in: .whitespacesAndNewlines))
            keyAvailable = true; keyNotice = "API-key veilig opgeslagen in macOS Sleutelhanger."
            showKeySheet = false; error = nil
        } catch { self.error = error.localizedDescription }
    }

    func removeKey() {
        do { try KeychainStore.remove(); keyAvailable = false; keyNotice = "API-key verwijderd uit Sleutelhanger." }
        catch { self.error = error.localizedDescription }
    }

    func requestGenerationQuote() {
        guard canGenerate else { return }
        busy = true; error = nil
        let selectedModel = model
        Task {
            do {
                guard let key = try KeychainStore.load() else { throw AppFailure("API-key ontbreekt.") }
                let price = try await FalClient(apiKey: key).pricing(model: selectedModel)
                if let rate = price.pricePerSecond {
                    quotedRate = rate; quotedModel = selectedModel
                    priceNotice = "Tarief zojuist opgehaald bij fal.ai."
                } else {
                    quotedRate = nil; quotedModel = nil
                    priceNotice = "Raming met het gepubliceerde tarief van 3 november 2026; fal.ai rekent per \(price.unit)."
                }
                showCostConfirmation = true
            } catch {
                self.error = "Tariefcontrole mislukt: \(error.localizedDescription)"
            }
            busy = false
        }
    }

    func acknowledgeUncertainSubmission() {
        let alert = NSAlert()
        alert.messageText = "Controleer eerst de fal.ai-wachtrij"
        alert.informativeText = "Het antwoord op een eerdere inzending is verloren gegaan. De generatie kan al gestart zijn. Als je opnieuw genereert, kunnen er dubbele kosten ontstaan. Heb je je dashboard gecontroleerd?"
        alert.addButton(withTitle: "Terug"); alert.addButton(withTitle: "Gecontroleerd, deblokkeer")
        if alert.runModal() == .alertSecondButtonReturn {
            do {
                try FileManager.default.removeItem(at: support.appendingPathComponent("submission-uncertain.txt"))
                submissionUncertain = false
            } catch { self.error = error.localizedDescription }
        }
    }

    func generate() {
        guard canGenerate, let media = prepared else { return }
        busy = true; isGenerating = true; error = nil
        let cameraInstructions = "Single continuous wide full-body shot. The tripod camera remains stationary at a fixed distance and focal length throughout. Keep the person centered and their complete body visible from the top of the head to both shoes, with generous space above the head, below the feet and on both sides for all dance movements. Maintain the initial wide framing throughout the entire clip, with a stable background and realistic proportions. "
        let selectedPrompt = steadyCamera ? cameraInstructions + String(prompt.prefix(1300)) : prompt
        let selectedModel = model, sound = keepSound, estimate = cost, selectedFace = faceURL, selectedAngles = angleURLs
        task = Task {
            do {
                guard let key = try KeychainStore.load() else { throw AppFailure("Voeg eerst je fal.ai API-key toe.") }
                let client = FalClient(apiKey: key)
                status = "1/4 · Referentiebeeld uploaden naar fal.ai…"
                let image = try await client.upload(file: media.referenceImageURL, mimeType: "image/jpeg")
                try Task.checkCancellation()
                status = "2/4 · Voorbereide dansclip uploaden…"
                let video = try await client.upload(file: media.danceVideoURL, mimeType: "video/mp4")
                try Task.checkCancellation()
                var face: URL?
                if let selectedFace {
                    status = "Extra gezichtsreferentie voorbereiden en uploaden…"
                    let local = media.danceVideoURL.deletingLastPathComponent().appendingPathComponent("gezicht.jpg")
                    try await MediaPreparation.extractReference(from: selectedFace, at: 0, to: local)
                    face = try await client.upload(file: local, mimeType: "image/jpeg")
                }
                var angles: [URL] = []
                if face != nil {
                    for (index, angle) in selectedAngles.prefix(3).enumerated() {
                        status = "Hoek \(index + 1) van \(min(3, selectedAngles.count)) uploaden…"
                        let local = media.danceVideoURL.deletingLastPathComponent().appendingPathComponent("hoek-\(index + 1).jpg")
                        try await MediaPreparation.extractReference(from: angle, at: 0, to: local)
                        angles.append(try await client.upload(file: local, mimeType: "image/jpeg"))
                    }
                }
                try Task.checkCancellation()
                // A durable marker prevents an ambiguous submission from being repeated silently.
                let marker = support.appendingPathComponent("submission-uncertain.txt")
                try "Inzending gestart. Controleer fal.ai als het antwoord verloren gaat; start niet automatisch opnieuw.".write(to: marker, atomically: true, encoding: .utf8)
                submissionUncertain = true
                status = "3/4 · Opdracht één keer indienen…"
                let job = try await client.submit(imageURL: image, videoURL: video, model: selectedModel, prompt: selectedPrompt, keepSound: sound, frontalImageURL: face, angleImageURLs: angles)
                let run = SavedRun(id: job.requestID, job: job, directory: media.danceVideoURL.deletingLastPathComponent(), estimate: estimate, resultURL: nil)
                runs.insert(run, at: 0); pendingRun = run
                try saveRuns()
                try? FileManager.default.removeItem(at: marker)
                submissionUncertain = false
                try await follow(run, client: client)
            } catch is CancellationError {
                self.error = nil
                status = pendingRun == nil ? "Voorbereiding of upload gestopt." : "Volgen gepauzeerd. De opdracht blijft bewaard en kan bij fal.ai doorlopen."
            } catch {
                if Task.isCancelled {
                    self.error = nil
                    status = "Volgen gepauzeerd. De opdracht blijft bewaard en kan bij fal.ai doorlopen."
                } else {
                    self.error = error.localizedDescription
                    status = pendingRun == nil ? "Niet automatisch opnieuw gestart. Controleer bij een verbindingsfout je fal.ai-wachtrij vóór je opnieuw genereert." : "Opdracht bewaard. Gebruik ‘Verder volgen’ om opnieuw verbinding te maken."
                }
            }
            busy = false; isGenerating = false
        }
    }

    func resume() {
        guard !busy, let run = pendingRun else { return }
        busy = true; isGenerating = true; error = nil
        task = Task {
            do {
                guard let key = try KeychainStore.load() else { throw AppFailure("Voeg je fal.ai-key toe om deze opdracht verder te volgen.") }
                try await follow(run, client: FalClient(apiKey: key))
            } catch is CancellationError {
                self.error = nil
                status = "Volgen gepauzeerd. De opdracht blijft bewaard en kan bij fal.ai doorlopen."
            } catch {
                if Task.isCancelled {
                    self.error = nil
                    status = "Volgen gepauzeerd. De opdracht blijft bewaard en kan bij fal.ai doorlopen."
                } else {
                    self.error = error.localizedDescription
                    status = "Opdracht bewaard. Verder volgen verbruikt geen nieuwe generatiecredits."
                }
            }
            busy = false; isGenerating = false
        }
    }

    private func follow(_ run: SavedRun, client: FalClient) async throws {
        let started = Date()
        while true {
            try Task.checkCancellation()
            let update = try await client.status(job: run.job)
            elapsed = Int(Date().timeIntervalSince(started))
            switch update.status {
            case "IN_QUEUE": status = "In de wachtrij\(update.queuePosition.map { " · plaats \($0)" } ?? "") · \(elapsed)s"
            case "IN_PROGRESS": status = "Je video wordt gemaakt · \(elapsed)s · je kunt dit venster openlaten."
            case "COMPLETED":
                status = "4/4 · MP4-resultaat downloaden…"
                let remote = try await client.result(job: run.job)
                let target = run.directory.appendingPathComponent("DanceForge-\(run.id.prefix(8)).mp4")
                if !FileManager.default.fileExists(atPath: target.path) { try await client.download(from: remote, to: target) }
                do { _ = try await MediaPreparation.inspectVideo(target) }
                catch { try? FileManager.default.removeItem(at: target); throw error }
                if let index = runs.firstIndex(where: { $0.id == run.id }) { runs[index].resultURL = target }
                try saveRuns(); pendingRun = nil; openResult(target)
                status = "Je video is klaar. Bekijk hem en exporteer als MP4."
                return
            case "FAILED", "CANCELLED": throw AppFailure(update.error ?? "fal.ai heeft de opdracht gestopt. Controleer de opdracht in je fal.ai-dashboard.")
            default: status = "fal.ai: \(update.status) · \(elapsed)s"
            }
            try await Task.sleep(for: .seconds(3))
        }
    }

    func pauseFollowing() {
        task?.cancel()
    }

    func cancelQueued() {
        guard let run = pendingRun else { return }
        task?.cancel()
        Task {
            do {
                guard let key = try KeychainStore.load() else { throw AppFailure("API-key ontbreekt.") }
                try await FalClient(apiKey: key).cancel(job: run.job)
                status = "Annulering aangevraagd. fal.ai bepaalt of de opdracht nog kan worden gestopt; kosten kunnen al zijn gemaakt."
            } catch { self.error = error.localizedDescription }
        }
    }

    func archivePending() {
        guard !busy, let run = pendingRun else { return }
        let alert = NSAlert()
        alert.messageText = "Deze opdracht niet meer volgen?"
        alert.informativeText = "De opdracht kan bij fal.ai nog doorlopen. Controleer eerst je dashboard. Een nieuwe generatie verbruikt opnieuw credits. Opdracht: \(run.id)"
        alert.addButton(withTitle: "Blijven volgen"); alert.addButton(withTitle: "Niet meer volgen")
        if alert.runModal() == .alertSecondButtonReturn {
            runs.removeAll { $0.id == run.id }; pendingRun = nil
            do { try saveRuns() } catch { self.error = error.localizedDescription }
        }
    }

    func openResult(_ url: URL) {
        resultPlayer?.pause(); resultURL = url; resultPlayer = AVPlayer(url: url)
        UserDefaults.standard.set(url.path, forKey: "lastResultPath")
    }

    func pickResult() {
        guard !busy else { return }
        let panel = NSOpenPanel(); panel.title = "Open een video om te bekijken of te exporteren"
        panel.allowedContentTypes = [.movie, .video]; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            do {
                _ = try await MediaPreparation.inspectVideo(url)
                openResult(url)
                status = "Video geopend: \(url.lastPathComponent)"
            } catch { self.error = error.localizedDescription }
        }
    }

    func exportResult() {
        guard let source = resultURL else { return }
        let panel = NSSavePanel(); panel.allowedContentTypes = [.mpeg4Movie]
        panel.nameFieldStringValue = "Mijn-dansvideo.mp4"; panel.title = "Exporteer je dansvideo"
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        Task {
            do { try await MediaPreparation.exportMP4(from: source, to: destination); status = "MP4 opgeslagen: \(destination.lastPathComponent)" }
            catch { self.error = error.localizedDescription }
        }
    }

    private func saveRuns() throws {
        let data = try JSONEncoder().encode(runs)
        try data.write(to: support.appendingPathComponent("runs.json"), options: .atomic)
    }
}

struct AppFailure: LocalizedError {
    var message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
