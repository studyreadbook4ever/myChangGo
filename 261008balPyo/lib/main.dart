import 'package:flutter/material.dart';

import 'app.dart';
import 'storage.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(ScriptReaderApp(storage: JsonDeckStorage()));
}
