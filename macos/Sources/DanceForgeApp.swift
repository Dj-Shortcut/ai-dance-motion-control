import SwiftUI
import AVKit

@main
struct DanceForgeApp: App {
    @StateObject private var app = AppModel()
    var body: some Scene {
        WindowGroup("DanceForge") {
            ContentView(app: app)
                .frame(minWidth: 1000, minHeight: 720)
                .preferredColorScheme(.dark)
        }
        .defaultSize(width: 1160, height: 860)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandMenu("Video") {
                Button("Open resultaatvideo…") { app.pickResult() }.keyboardShortcut("o").disabled(app.busy)
                Button("Kies eigen video…") { app.pick(person: true) }.keyboardShortcut("1").disabled(app.busy)
                Button("Kies dansreferentie…") { app.pick(person: false) }.keyboardShortcut("2").disabled(app.busy)
                Button("Exporteer MP4…") { app.exportResult() }.keyboardShortcut("e").disabled(app.resultURL == nil)
            }
        }
    }
}

struct PlainPlayer: NSViewRepresentable {
    let player: AVPlayer
    var controls: AVPlayerViewControlsStyle = .none
    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.controlsStyle = controls
        view.videoGravity = .resizeAspect
        view.player = player
        return view
    }
    func updateNSView(_ view: AVPlayerView, context: Context) {
        if view.player !== player { view.player = player }
        view.controlsStyle = controls
    }
}

struct ContentView: View {
    @ObservedObject var app: AppModel
    @State private var showSettings = false
    private let accent = Color(red: 0.52, green: 0.88, blue: 0.73)
    private let background = Color(red: 0.065, green: 0.078, blue: 0.085)

    var body: some View {
        makeScreen
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(background)
        .tint(accent)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { app.showKeySheet = true } label: {
                    Image(systemName: app.keyAvailable ? "lock.shield" : "key.fill")
                }.help(app.keyAvailable ? "fal.ai-key veilig bewaard" : "fal.ai API-key toevoegen")
            }
        }
        .sheet(isPresented: $app.showKeySheet) { KeySheet(app: app) }
        .alert("Betaalde generatie bevestigen", isPresented: $app.showCostConfirmation) {
            Button("Annuleer", role: .cancel) {}
            Button("Bevestig · ± \(app.costLabel)") { app.generate() }
        } message: {
            Text("\(app.model.title)\n\(String(format: "%.2f", app.prepared?.duration ?? app.duration)) seconden · geschat \(app.costLabel) USD\n\n\(app.inputDescription)\n\nJe referentiebeeld en voorbereide dansclip worden geüpload naar fal.ai. Dit verbruikt je fal.ai-tegoed. De definitieve kosten volgen het tarief van fal.ai. Er wordt één opdracht ingediend.")
        }
        .onChange(of: app.personTime) { _, _ in app.updateFrame() }
        .onChange(of: app.personOffset) { _, _ in app.updateFrame() }
        .onChange(of: app.danceStart) { _, _ in app.invalidate(); app.duration = min(app.duration, app.maxDuration) }
        .onChange(of: app.duration) { _, _ in app.invalidate() }
        .onChange(of: app.cropEnabled) { _, _ in app.invalidate() }
        .onChange(of: app.cropX) { _, _ in app.invalidate() }
        .onChange(of: app.cropY) { _, _ in app.invalidate() }
        .onChange(of: app.cropWidth) { _, _ in app.invalidate() }
        .onChange(of: app.cropHeight) { _, _ in app.invalidate() }
    }

    // MARK: Maken

    private var makeScreen: some View {
        VStack(spacing: 18) {
            HStack(alignment: .top, spacing: 18) {
                slot(person: true)
                slot(person: false)
            }
            .frame(maxHeight: .infinity)
            resultPanel
                .frame(maxHeight: .infinity)
            if let run = app.pendingRun { pendingLine(run) }
            if app.submissionUncertain && app.pendingRun == nil { uncertainLine }
            bottomBar
        }
        .padding(.horizontal, 24).padding(.vertical, 18)
    }

    private func slot(person: Bool) -> some View {
        let url = person ? app.personURL : app.danceURL
        return VStack(alignment: .leading, spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 14).fill(Color.black.opacity(0.55))
                if person, let image = app.referenceImage {
                    Image(nsImage: image).resizable().scaledToFit()
                } else if !person, let player = app.dancePlayer {
                    PlainPlayer(player: player)
                        .overlay {
                            if app.cropEnabled && app.prepared == nil, let metadata = app.danceMetadata {
                                CropOverlay(app: app, metadata: metadata)
                            } else {
                                Color.clear.contentShape(Rectangle()).onTapGesture {
                                    player.timeControlStatus == .playing ? player.pause() : player.play()
                                }
                            }
                        }
                } else {
                    Button { app.pick(person: person) } label: {
                        VStack(spacing: 10) {
                            Image(systemName: "plus").font(.system(size: 26, weight: .light))
                            Text(person ? "Jouw video of foto" : "Dansvideo")
                        }
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity).contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(app.busy)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .frame(maxHeight: .infinity)

            HStack(spacing: 10) {
                Text(person ? "Jij" : "Dans").font(.callout.weight(.medium))
                if let url {
                    Menu {
                        Button("Ander bestand…") { app.pick(person: person) }
                        let items = app.library.filter { person ? $0.isImage || !$0.isResult : !$0.isImage && !$0.isResult }
                        if !items.isEmpty { Divider() }
                        ForEach(items) { item in Button("\(item.folder) / \(item.name)") { app.select(item.url, person: person) } }
                    } label: {
                        Text(url.lastPathComponent).lineLimit(1).truncationMode(.middle)
                    }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize(horizontal: false, vertical: true)
                    .tint(.secondary).foregroundStyle(.secondary).font(.callout).disabled(app.busy)
                    .help("Klik om een ander bestand te kiezen")
                }
                Spacer(minLength: 0)
                if person && app.personMetadata != nil {
                    Slider(value: $app.personTime, in: 0...max(0.01, app.personMaxTime), step: 0.05)
                        .controlSize(.mini).frame(maxWidth: 200).disabled(app.busy)
                        .help("Kies één scherp beeld met je volledige lichaam")
                    Text(String(format: "%.1f s", app.personTime)).monospacedDigit().foregroundStyle(.secondary).font(.callout)
                }
                if !person && app.danceMetadata != nil { trimControls }
            }
            .frame(height: 22)
        }
        .frame(maxWidth: .infinity)
    }

    private var trimControls: some View {
        HStack(spacing: 6) {
            TextField("0", value: $app.danceStart, format: .number.precision(.fractionLength(0...2)))
                .frame(width: 38).multilineTextAlignment(.trailing).textFieldStyle(.plain)
                .help("Start in seconden")
            Text("s +").foregroundStyle(.tertiary)
            Stepper("\(String(format: "%.0f", app.duration)) s", value: $app.duration, in: 3...max(3, app.maxDuration), step: 1)
                .monospacedDigit().help("Duur van de clip")
            Button { app.cropEnabled.toggle() } label: {
                Image(systemName: "crop").foregroundStyle(app.cropEnabled ? accent : .secondary)
            }
            .buttonStyle(.plain).padding(.leading, 6)
            .help(app.cropEnabled ? "Uitsnede aan · sleep een kader in de video" : "Uitsnede")
        }
        .font(.callout).disabled(app.busy)
    }

    // MARK: Onderbalk

    private var bottomBar: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                if let error = app.error {
                    Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange).lineLimit(2)
                } else {
                    Text(app.status).foregroundStyle(.secondary).lineLimit(2)
                }
                if app.busy {
                    if app.isGenerating { ProgressView().progressViewStyle(.linear).frame(maxWidth: 260) }
                    else { ProgressView(value: app.preparationProgress).frame(maxWidth: 260) }
                }
            }
            .font(.callout).textSelection(.enabled)
            Spacer()
            Button { showSettings.toggle() } label: {
                Image(systemName: "slider.horizontal.3").font(.system(size: 15))
            }
            .buttonStyle(.plain).foregroundStyle(.secondary)
            .help("Instellingen")
            .popover(isPresented: $showSettings, arrowEdge: .top) { settings }
            primaryButton
        }
    }

    @ViewBuilder private var primaryButton: some View {
        if app.prepared == nil {
            Button { app.prepare() } label: { Text("Bereid voor").frame(minWidth: 130) }
                .buttonStyle(.borderedProminent).foregroundStyle(.black).controlSize(.large)
                .disabled(!app.canPrepare)
                .help("Gratis, gebeurt op je Mac · daarna ± \(app.costLabel) voor \(app.model.title)")
        } else {
            Button { app.requestGenerationQuote() } label: { Text("Genereer · ± \(app.costLabel)").frame(minWidth: 130) }
                .buttonStyle(.borderedProminent).foregroundStyle(.black).controlSize(.large)
                .disabled(!app.canGenerate)
                .help("\(app.priceNotice) Je bevestigt vóór upload naar fal.ai.")
        }
    }

    private var settings: some View {
        VStack(alignment: .leading, spacing: 14) {
            Picker("Kwaliteit", selection: $app.model) {
                ForEach(FalModel.allCases, id: \.self) { model in Text(model.title).tag(model) }
            }.pickerStyle(.segmented).labelsHidden()
            Toggle("Geluid van de dansvideo behouden", isOn: $app.keepSound)
            Toggle("Ruim beeld en rustige camera", isOn: $app.steadyCamera)
            Divider()
            HStack {
                Button("Gezichtsreferentie…") { app.pickFace() }
                if let face = app.faceURL {
                    Text(face.lastPathComponent).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Button { app.faceURL = nil } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }
            HStack {
                Button("Hoeken…") { app.pickAngles() }
                    .help("Tot 3 beelden van je zijkant en rug, bijvoorbeeld uit een 360 van jezelf. Gaan mee met je gezichtsreferentie.")
                if !app.angleURLs.isEmpty {
                    Text(app.angleURLs.map(\.lastPathComponent).joined(separator: ", ")).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    Button { app.angleURLs = [] } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }
            HStack {
                Button("Achtergrond…") { app.pickBackground() }
                    .help("Een foto (of video) van je lege ruimte, zodat ook zichtbaar is wat achter je staat")
                if let background = app.backgroundURL {
                    Text(background.lastPathComponent).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Button { app.clearBackground() } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).foregroundStyle(.secondary)
                }
            }
            if app.backgroundURL != nil {
                HStack(spacing: 8) {
                    Image(systemName: "arrow.left.and.right").foregroundStyle(.secondary)
                    Slider(value: $app.personOffset, in: -0.4...0.4).controlSize(.small)
                    Button("Midden") { app.personOffset = 0 }.buttonStyle(.borderless).font(.caption)
                }
                .help("Schuif jezelf opzij zodat wat achter je staat zichtbaar wordt. Kijk naar het Jij-beeld.")
            }
            TextField("Beschrijving (optioneel)", text: $app.prompt, axis: .vertical)
                .lineLimit(3...5).textFieldStyle(.roundedBorder)
        }
        .padding(18).frame(width: 340).disabled(app.busy)
    }

    private func pendingLine(_ run: SavedRun) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "clock.arrow.circlepath").foregroundStyle(accent)
            Text("Opdracht \(run.id.prefix(8)) loopt bij fal.ai").foregroundStyle(.secondary)
            Spacer()
            if app.isGenerating { Button("Pauzeer") { app.pauseFollowing() } }
            else { Button("Verder volgen") { app.resume() }.disabled(app.busy) }
            Menu {
                Button("Annulering aanvragen") { app.cancelQueued() }
                Button("Niet meer volgen…") { app.archivePending() }.disabled(app.busy)
                Divider()
                Link("Open fal.ai-dashboard", destination: URL(string: "https://fal.ai/dashboard/requests")!)
            } label: { Image(systemName: "ellipsis") }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        }
        .font(.callout)
        .help("Verder volgen dient geen nieuwe generatie in. Een opdracht loopt bij fal.ai door als je de app sluit.")
    }

    private var uncertainLine: some View {
        HStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            Text("Eerdere inzending onzeker — controleer je fal.ai-wachtrij.").foregroundStyle(.secondary)
            Spacer()
            Link("Dashboard", destination: URL(string: "https://fal.ai/dashboard/requests")!)
            Button("Gecontroleerd…") { app.acknowledgeUncertainSubmission() }
        }.font(.callout)
    }

    // MARK: Resultaat

    private var resultPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 14).fill(Color.black.opacity(0.55))
                if let player = app.resultPlayer {
                    PlainPlayer(player: player, controls: .floating)
                } else {
                    VStack(spacing: 8) {
                        Image(systemName: "film").font(.system(size: 26, weight: .light))
                        Text("Je resultaat verschijnt hier")
                    }.foregroundStyle(.secondary)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .frame(maxHeight: .infinity)
            HStack(spacing: 10) {
                Text("Resultaat").font(.callout.weight(.medium))
                Menu {
                    Button("Open video…") { app.pickResult() }
                    let runs = app.runs.filter { $0.resultURL != nil }
                    let results = app.library.filter(\.isResult)
                    if !runs.isEmpty || !results.isEmpty { Divider() }
                    ForEach(runs) { run in
                        Button("DanceForge · \(run.id.prefix(8))") { if let url = run.resultURL { app.openResult(url) } }
                    }
                    ForEach(results) { item in Button("\(item.folder) / \(item.name)") { app.openResult(item.url) } }
                } label: {
                    Text(app.resultURL?.lastPathComponent ?? "Open video…").lineLimit(1).truncationMode(.middle)
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize(horizontal: false, vertical: true)
                .tint(.secondary).foregroundStyle(.secondary).disabled(app.busy)
                .help("Open een eerder resultaat")
                Spacer()
                Button { app.exportResult() } label: { Label("Exporteer", systemImage: "square.and.arrow.up") }
                    .buttonStyle(.plain).foregroundStyle(app.resultURL == nil ? Color.secondary.opacity(0.4) : accent)
                    .disabled(app.resultURL == nil)
                    .help("Exporteer MP4…")
            }
            .font(.callout).frame(height: 22)
        }
    }
}

struct CropOverlay: View {
    @ObservedObject var app: AppModel
    let metadata: VideoMetadata
    var body: some View {
        GeometryReader { geometry in
            let scale = min(geometry.size.width / Double(metadata.width), geometry.size.height / Double(metadata.height))
            let originX = (geometry.size.width - Double(metadata.width) * scale) / 2
            let originY = (geometry.size.height - Double(metadata.height) * scale) / 2
            ZStack(alignment: .topLeading) {
                Color.black.opacity(0.08)
                Rectangle().stroke(Color.mint, lineWidth: 2)
                    .frame(width: max(0, app.cropWidth * scale), height: max(0, app.cropHeight * scale))
                    .offset(x: originX + app.cropX * scale, y: originY + app.cropY * scale)
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 3).onChanged { value in
                guard !app.busy else { return }
                let x1 = min(Double(metadata.width), max(0, (value.startLocation.x - originX) / scale))
                let y1 = min(Double(metadata.height), max(0, (value.startLocation.y - originY) / scale))
                let x2 = min(Double(metadata.width), max(0, (value.location.x - originX) / scale))
                let y2 = min(Double(metadata.height), max(0, (value.location.y - originY) / scale))
                app.cropX = min(x1, x2).rounded(); app.cropY = min(y1, y2).rounded()
                app.cropWidth = max(1, abs(x2 - x1).rounded()); app.cropHeight = max(1, abs(y2 - y1).rounded())
            })
        }
    }
}

struct KeySheet: View {
    @ObservedObject var app: AppModel
    @State private var key = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label("fal.ai API-key", systemImage: "lock.shield").font(.title2.bold())
            Text("Plak je key één keer. macOS bewaart hem veilig in Sleutelhanger; je video's en de appbroncode bevatten hem niet.").foregroundStyle(.secondary)
            SecureField("fal.ai API-key", text: $key).textFieldStyle(.roundedBorder)
            if let error = app.error { Text(error).foregroundStyle(.orange).font(.caption) }
            HStack {
                Link("API-key aanmaken", destination: URL(string: "https://fal.ai/dashboard/keys")!)
                Spacer()
                Button("Sluiten") { app.showKeySheet = false }
                Button("Bewaar veilig") { app.saveKey(key); key = "" }.buttonStyle(.borderedProminent).disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if app.keyAvailable { Button("Verwijder bewaarde key", role: .destructive) { app.removeKey() }.font(.caption) }
        }.padding(28).frame(width: 490)
    }
}
