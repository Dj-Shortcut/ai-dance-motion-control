import Foundation
import Security

enum KeychainStore {
    private static let service = "com.djshortcut.DanceForge.fal"
    private static let account = "FAL_KEY"

    static func load() throws -> String? {
        try read(service: service, account: account)
    }

    static func save(_ key: String) throws {
        try write(key, service: service, account: account)
    }

    static func remove() throws {
        try delete(service: service, account: account)
    }

    /// Imports the credential already used by the user's existing renderer.
    /// The original file is never changed and its content is never logged.
    @discardableResult
    static func importExistingKeyIfAvailable() throws -> Bool {
        guard try load() == nil else { return false }
        let source = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Desktop/kan-truc-render/.env")
        guard let content = try? String(contentsOf: source, encoding: .utf8) else { return false }
        for originalLine in content.components(separatedBy: .newlines) {
            var line = originalLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("export ") { line.removeFirst(7) }
            guard let separator = line.firstIndex(of: "="),
                  line[..<separator].trimmingCharacters(in: .whitespaces) == account else { continue }
            var value = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespaces)
            if (value.hasPrefix("\"") && value.hasSuffix("\"")) ||
                (value.hasPrefix("'") && value.hasSuffix("'")) {
                value = String(value.dropFirst().dropLast())
            } else if let comment = value.range(of: " #") {
                value = String(value[..<comment.lowerBound]).trimmingCharacters(in: .whitespaces)
            }
            guard !value.isEmpty else { continue }
            try save(value)
            return true
        }
        return false
    }

    /// Uses an isolated throwaway item; never touches the real fal.ai key.
    static func selfTest() throws {
        let testService = service + ".selftest." + UUID().uuidString
        let testAccount = "selftest"
        defer { try? delete(service: testService, account: testAccount) }
        guard try read(service: testService, account: testAccount) == nil else {
            throw StoreError.verification
        }
        try write("temporary-first-value", service: testService, account: testAccount)
        guard try read(service: testService, account: testAccount) == "temporary-first-value" else {
            throw StoreError.verification
        }
        try write("temporary-updated-value", service: testService, account: testAccount)
        guard try read(service: testService, account: testAccount) == "temporary-updated-value" else {
            throw StoreError.verification
        }
        try delete(service: testService, account: testAccount)
        guard try read(service: testService, account: testAccount) == nil else {
            throw StoreError.verification
        }
    }

    private static func query(service: String, account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    private static func read(service: String, account: String) throws -> String? {
        var request = query(service: service, account: account)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw StoreError.status(status) }
        guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
            throw StoreError.invalidData
        }
        return value
    }

    private static func write(_ rawKey: String, service: String, account: String) throws {
        let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty, key.utf8.count <= 4096,
              !key.contains(where: { $0.isNewline || $0 == "\0" }) else {
            throw StoreError.invalidKey
        }
        let data = Data(key.utf8)
        let base = query(service: service, account: account)
        let status = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw StoreError.status(status) }
        var creation = base
        creation[kSecValueData as String] = data
        creation[kSecAttrLabel as String] = "DanceForge — fal.ai API-key"
        creation[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let creationStatus = SecItemAdd(creation as CFDictionary, nil)
        guard creationStatus == errSecSuccess else { throw StoreError.status(creationStatus) }
    }

    private static func delete(service: String, account: String) throws {
        let status = SecItemDelete(query(service: service, account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw StoreError.status(status)
        }
    }

    enum StoreError: LocalizedError {
        case status(OSStatus)
        case invalidData
        case invalidKey
        case verification

        var errorDescription: String? {
            switch self {
            case .status(let status):
                return "macOS Sleutelhanger is niet beschikbaar (code \(status)). Ontgrendel je sleutelhanger en probeer opnieuw."
            case .invalidData: return "De opgeslagen API-key kan niet worden gelezen. Bewaar je key opnieuw."
            case .invalidKey: return "Plak een geldige API-key op één regel."
            case .verification: return "De controle van macOS Sleutelhanger is niet geslaagd."
            }
        }
    }
}
