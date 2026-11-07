import Foundation

struct LibraryVideo: Identifiable, Hashable {
    let url: URL
    let name: String
    let folder: String
    let isImage: Bool
    let isResult: Bool
    var id: String { url.path }
}

enum ExistingLibrary {
    private static let videoExtensions: Set<String> = ["mp4", "mov", "m4v"]
    private static let imageExtensions: Set<String> = ["jpg", "jpeg", "png", "heic", "heif", "tif", "tiff", "webp", "gif"]

    /// Reads only visible media directly in the known renderer folders and Desktop.
    /// Neither scripts, environment files nor credentials are included.
    static func scan() -> [LibraryVideo] {
        let desktop = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Desktop", isDirectory: true)
        let folders = [desktop] + ["ai-dance-motion-control", "jookin-render", "kan-truc-render"].map {
            desktop.appendingPathComponent($0, isDirectory: true)
        }
        return scan(folders: folders)
    }

    static func scan(folders: [URL]) -> [LibraryVideo] {
        var seen = Set<String>()
        var media: [LibraryVideo] = []
        for folderURL in folders {
            guard let contents = try? FileManager.default.contentsOfDirectory(
                at: folderURL,
                includingPropertiesForKeys: [.isRegularFileKey],
                options: [.skipsHiddenFiles]
            ) else { continue }
            for url in contents {
                let ext = url.pathExtension.lowercased()
                guard videoExtensions.contains(ext) || imageExtensions.contains(ext),
                      (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true,
                      seen.insert(url.standardizedFileURL.path).inserted else { continue }
                let lowerName = url.lastPathComponent.lowercased()
                media.append(LibraryVideo(
                    url: url,
                    name: url.deletingPathExtension().lastPathComponent.replacingOccurrences(of: "_", with: " "),
                    folder: folderURL.lastPathComponent,
                    isImage: imageExtensions.contains(ext),
                    isResult: lowerName.hasPrefix("resultaat") || lowerName.hasPrefix("result") || lowerName.hasPrefix("output")
                ))
            }
        }
        return media.sorted {
            let folderOrder = $0.folder.localizedStandardCompare($1.folder)
            if folderOrder != .orderedSame { return folderOrder == .orderedAscending }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
    }
}
