import Foundation
@preconcurrency import AVFoundation
import AppKit
import ImageIO
import UniformTypeIdentifiers

struct VideoMetadata: Codable, Sendable {
    let duration: Double
    let width: Int
    let height: Int
    let frameRate: Double
    let hasAudio: Bool
}

struct VideoCrop: Codable, Sendable, Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct PreparedMedia: Codable, Sendable {
    let referenceImageURL: URL
    let danceVideoURL: URL
    let duration: Double
    let frameCount: Int
    let personMetadata: VideoMetadata?
    let danceMetadata: VideoMetadata
}

enum MediaPreparationError: LocalizedError {
    case invalid(String)
    case export(String)
    var errorDescription: String? {
        switch self {
        case .invalid(let message), .export(let message): return message
        }
    }
}

// AVFoundation supports observing progress and cancelling an active export from another queue.
// Configuration is completed before this handle is shared; only these supported operations follow.
private final class MediaExportHandle: @unchecked Sendable {
    private let session: AVAssetExportSession
    init(_ session: AVAssetExportSession) { self.session = session }
    var progress: Double { Double(session.progress) }
    func cancel() { session.cancelExport() }
    func export(to url: URL) async throws {
        if #available(macOS 15.0, *) {
            try await session.export(to: url, as: .mp4)
        } else {
            session.outputURL = url
            session.outputFileType = .mp4
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                session.exportAsynchronously { [self] in
                    if session.status == .completed { continuation.resume() }
                    else { continuation.resume(throwing: session.error ?? MediaPreparationError.export("Omzetten naar MP4 is mislukt.")) }
                }
            }
        }
    }
}

enum MediaPreparation {
    static let outputFrameRate: Int32 = 30

    static func inspectVideo(_ url: URL) async throws -> VideoMetadata {
        try Task.checkCancellation()
        guard url.isFileURL, FileManager.default.isReadableFile(atPath: url.path) else {
            throw MediaPreparationError.invalid("Deze video is niet leesbaar. Kies het bestand opnieuw.")
        }
        let asset = AVURLAsset(url: url)
        guard try await asset.load(.isPlayable) else {
            throw MediaPreparationError.invalid("Deze video kan niet worden afgespeeld. Kies een ander videobestand.")
        }
        let duration = try await asset.load(.duration).seconds
        guard duration.isFinite, duration > 0,
              let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw MediaPreparationError.invalid("Dit bestand bevat geen bruikbare video.")
        }
        let size = try await track.load(.naturalSize)
        let transform = try await track.load(.preferredTransform)
        let rect = CGRect(origin: .zero, size: size).applying(transform).standardized
        let fps = try await track.load(.nominalFrameRate)
        guard rect.width.isFinite, rect.height.isFinite, rect.width >= 2, rect.height >= 2 else {
            throw MediaPreparationError.invalid("De video heeft ongeldige afmetingen.")
        }
        return VideoMetadata(duration: duration, width: Int(rect.width.rounded()),
                             height: Int(rect.height.rounded()), frameRate: Double(fps),
                             hasAudio: !(try await asset.loadTracks(withMediaType: .audio)).isEmpty)
    }

    static func isImage(_ url: URL) -> Bool {
        guard url.isFileURL else { return false }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let identifier = CGImageSourceGetType(source),
              let type = UTType(identifier as String) else { return false }
        return type.conforms(to: .image)
    }

    static func exportMP4(from sourceURL: URL, to destinationURL: URL) async throws {
        try Task.checkCancellation()
        _ = try await inspectVideo(sourceURL)
        guard destinationURL.isFileURL, destinationURL.pathExtension.lowercased() == "mp4" else {
            throw MediaPreparationError.invalid("Kies een bestandsnaam die eindigt op .mp4.")
        }
        if sourceURL.standardizedFileURL == destinationURL.standardizedFileURL { return }
        let fileManager = FileManager.default
        let parent = destinationURL.deletingLastPathComponent()
        try fileManager.createDirectory(at: parent, withIntermediateDirectories: true)
        let temporaryURL = parent.appendingPathComponent(".danceforge-export-\(UUID().uuidString).mp4")
        defer { try? fileManager.removeItem(at: temporaryURL) }
        if sourceURL.pathExtension.lowercased() == "mp4" {
            try fileManager.copyItem(at: sourceURL, to: temporaryURL)
        } else {
            let asset = AVURLAsset(url: sourceURL)
            guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality) else {
                throw MediaPreparationError.export("Deze video kan niet naar MP4 worden omgezet.")
            }
            session.shouldOptimizeForNetworkUse = true
            let handle = MediaExportHandle(session)
            do {
                try await withTaskCancellationHandler(operation: {
                    try await handle.export(to: temporaryURL)
                }, onCancel: { handle.cancel() })
            } catch {
                if Task.isCancelled { throw CancellationError() }
                throw MediaPreparationError.export("Exporteren naar MP4 is mislukt: \(error.localizedDescription)")
            }
        }
        try Task.checkCancellation()
        _ = try await inspectVideo(temporaryURL)
        try Task.checkCancellation()
        if fileManager.fileExists(atPath: destinationURL.path) {
            _ = try fileManager.replaceItemAt(destinationURL, withItemAt: temporaryURL)
        } else {
            try fileManager.moveItem(at: temporaryURL, to: destinationURL)
        }
    }

    static func extractReference(from url: URL, at seconds: Double, to outputURL: URL) async throws {
        try Task.checkCancellation()
        guard seconds.isFinite, seconds >= 0 else {
            throw MediaPreparationError.invalid("Kies een geldig tijdstip voor je referentiebeeld.")
        }
        let image: CGImage
        if isImage(url), let source = CGImageSourceCreateWithURL(url as CFURL, nil) {
            let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                                           kCGImageSourceCreateThumbnailWithTransform: true,
                                           kCGImageSourceThumbnailMaxPixelSize: 1280]
            guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
                throw MediaPreparationError.invalid("Deze foto kan niet worden geopend.")
            }
            image = thumbnail
        } else {
            let metadata = try await inspectVideo(url)
            guard seconds < metadata.duration else {
                throw MediaPreparationError.invalid("Het gekozen referentiebeeld ligt voorbij het einde van je video.")
            }
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 1280, height: 1280)
            generator.requestedTimeToleranceBefore = .zero
            generator.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 30)
            do {
                let result = try await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600))
                image = result.image
            } catch {
                if Task.isCancelled { throw CancellationError() }
                throw MediaPreparationError.invalid("Dit beeld kon niet worden gelezen. Kies een ander tijdstip.")
            }
        }
        try Task.checkCancellation()
        guard image.width >= 64, image.height >= 64 else {
            throw MediaPreparationError.invalid("De referentie is te klein. Gebruik een duidelijker beeld.")
        }
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.93]) else {
            throw MediaPreparationError.export("Het referentiebeeld kon niet worden opgeslagen.")
        }
        try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try jpeg.write(to: outputURL, options: .atomic)
    }

    static func prepare(personURL: URL, personTime: Double, danceURL: URL, danceStart: Double,
                        duration: Double, outputDirectory: URL,
                        crop: VideoCrop? = nil,
                        background: URL? = nil, personOffset: Double = 0,
                        progress: @escaping @Sendable (Double) -> Void = { _ in }) async throws -> PreparedMedia {
        try Task.checkCancellation()
        guard danceStart.isFinite, danceStart >= 0, duration.isFinite,
              duration >= 3, duration <= 20 else {
            throw MediaPreparationError.invalid("Kies een dansfragment van 3 tot 20 seconden en een geldig startpunt.")
        }
        let metadata = try await inspectVideo(danceURL)
        try validateCrop(crop, displayWidth: Double(metadata.width), displayHeight: Double(metadata.height))
        let frameCount = Int((duration * Double(outputFrameRate)).rounded(.down))
        let preparedDuration = Double(frameCount) / Double(outputFrameRate)
        guard danceStart + preparedDuration <= metadata.duration + 0.001 else {
            throw MediaPreparationError.invalid("Het dansfragment loopt voorbij het einde. Kies een kortere duur of een vroeger startpunt.")
        }
        try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        let referenceURL = outputDirectory.appendingPathComponent("persoon.jpg")
        let videoURL = outputDirectory.appendingPathComponent("dans-30fps.mp4")
        guard !FileManager.default.fileExists(atPath: referenceURL.path),
              !FileManager.default.fileExists(atPath: videoURL.path) else {
            throw MediaPreparationError.invalid("Deze werkmap bevat al voorbereide bestanden. Start een nieuwe voorbereiding.")
        }
        progress(0.05)
        let personMetadata = isImage(personURL) ? nil : try await inspectVideo(personURL)
        try await extractReference(from: personURL, at: personTime, to: referenceURL)
        if let background {
            try BackgroundComposite.apply(personImageURL: referenceURL, backgroundURL: background,
                                          offset: personOffset, to: referenceURL)
        }
        progress(0.15)
        do {
            try await exportDance(from: danceURL, start: danceStart, frameCount: frameCount,
                                  to: videoURL, crop: crop, progress: progress)
            try Task.checkCancellation()
            let outputMetadata = try await inspectVideo(videoURL)
            guard abs(outputMetadata.duration - preparedDuration) <= 0.1,
                  abs(outputMetadata.frameRate - Double(outputFrameRate)) <= 0.05 else {
                throw MediaPreparationError.export("De videovoorbereiding heeft een onverwachte duur of beeldsnelheid. Probeer een ander fragment.")
            }
            progress(1)
            return PreparedMedia(referenceImageURL: referenceURL, danceVideoURL: videoURL,
                                 duration: preparedDuration, frameCount: frameCount,
                                 personMetadata: personMetadata, danceMetadata: outputMetadata)
        } catch {
            try? FileManager.default.removeItem(at: videoURL)
            throw error
        }
    }

    private static func exportDance(from sourceURL: URL, start: Double, frameCount: Int,
                                    to outputURL: URL, crop: VideoCrop?,
                                    progress: @escaping @Sendable (Double) -> Void) async throws {
        let source = AVURLAsset(url: sourceURL)
        guard let sourceTrack = try await source.loadTracks(withMediaType: .video).first else {
            throw MediaPreparationError.invalid("De dansvideo bevat geen videobeeld.")
        }
        let naturalSize = try await sourceTrack.load(.naturalSize)
        let preferredTransform = try await sourceTrack.load(.preferredTransform)
        let sourceRect = CGRect(origin: .zero, size: naturalSize).applying(preferredTransform).standardized
        try validateCrop(crop, displayWidth: sourceRect.width, displayHeight: sourceRect.height)
        let cropRect = crop.map { CGRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height) }
            ?? CGRect(origin: .zero, size: sourceRect.size)
        let portrait = cropRect.height > cropRect.width
        let scale = min(1, (portrait ? 720 : 1280) / cropRect.width, (portrait ? 1280 : 720) / cropRect.height)
        let renderSize = CGSize(width: max(2, floor(cropRect.width * scale / 2) * 2),
                                height: max(2, floor(cropRect.height * scale / 2) * 2))
        let composition = AVMutableComposition()
        guard let videoTrack = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw MediaPreparationError.export("De videovoorbereiding kon niet starten.")
        }
        let timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 600),
                                    duration: CMTime(value: Int64(frameCount), timescale: outputFrameRate))
        try videoTrack.insertTimeRange(timeRange, of: sourceTrack, at: .zero)
        let audioTracks = try await source.loadTracks(withMediaType: .audio)
        if let sourceAudio = audioTracks.first,
           let audioTrack = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
            // Keep reference music when the selected range has audio. Some camera files end their audio earlier.
            let sourceAudioRange = try await sourceAudio.load(.timeRange)
            let intersection = CMTimeRangeGetIntersection(timeRange, otherRange: sourceAudioRange)
            if intersection.isValid, intersection.duration.seconds > 0 {
                try audioTrack.insertTimeRange(intersection, of: sourceAudio,
                                               at: CMTimeSubtract(intersection.start, timeRange.start))
            }
        }
        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = CMTimeRange(start: .zero, duration: timeRange.duration)
        let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
        let normalized = preferredTransform
            .concatenating(CGAffineTransform(translationX: -sourceRect.minX - cropRect.minX,
                                           y: -sourceRect.minY - cropRect.minY))
            .concatenating(CGAffineTransform(scaleX: renderSize.width / cropRect.width,
                                           y: renderSize.height / cropRect.height))
        layer.setTransform(normalized, at: .zero)
        instruction.layerInstructions = [layer]
        let videoComposition = AVMutableVideoComposition()
        videoComposition.renderSize = renderSize
        videoComposition.frameDuration = CMTime(value: 1, timescale: outputFrameRate)
        videoComposition.instructions = [instruction]
        guard let exporter = AVAssetExportSession(asset: composition, presetName: AVAssetExportPreset1280x720) else {
            throw MediaPreparationError.export("Deze video kan niet naar MP4 worden omgezet.")
        }
        exporter.videoComposition = videoComposition
        exporter.shouldOptimizeForNetworkUse = true
        let handle = MediaExportHandle(exporter)
        let progressTask = Task {
            while !Task.isCancelled {
                progress(0.15 + handle.progress * 0.8)
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
        }
        defer { progressTask.cancel() }
        do {
            try await withTaskCancellationHandler(operation: {
                try await handle.export(to: outputURL)
            }, onCancel: { handle.cancel() })
        } catch {
            if Task.isCancelled { throw CancellationError() }
            throw MediaPreparationError.export("Omzetten naar MP4 is mislukt: \(error.localizedDescription)")
        }
    }

    private static func validateCrop(_ crop: VideoCrop?, displayWidth: Double, displayHeight: Double) throws {
        guard let crop else { return }
        guard crop.x.isFinite, crop.y.isFinite, crop.width.isFinite, crop.height.isFinite,
              crop.x >= 0, crop.y >= 0, crop.width >= 64, crop.height >= 64,
              crop.x + crop.width <= displayWidth + 0.001,
              crop.y + crop.height <= displayHeight + 0.001 else {
            throw MediaPreparationError.invalid("Kies een uitsnede binnen het videobeeld van minstens 64 × 64 pixels.")
        }
    }
}
